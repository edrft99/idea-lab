import { AppError } from "../ideas/errors";
import { Operations, digest, type Operation } from "../ideas/operations";
import { pairKey } from "../reviews/model";
import { LinkRepository } from "./repository";
import {
  linkCommandSchema,
  linkContentHash,
  type LinkCommand,
  type LinkJournal,
} from "./model";
export class LinkService {
  constructor(
    private repository: LinkRepository,
    private operations: Operations,
  ) {}
  private async checked(command: LinkCommand) {
    await this.repository.preflight();
    const ideas = await Promise.all([
      this.repository.get(command.candidateId),
      this.repository.get(command.matchingId),
    ]);
    for (const [index, idea] of ideas.entries()) {
      if (idea.canonicalIdeaId)
        throw new AppError(
          "SUPERSEDED_IDEA",
          "Choose the surviving idea before linking.",
          409,
        );
      if (
        idea.revision !==
        [command.candidateRevision, command.matchingRevision][index]
      )
        throw new AppError(
          "STALE_IDEA",
          "One of the ideas changed. Reload and review the link again.",
          409,
        );
      if (
        idea.relatedIdeaIds.length >= 100 &&
        !idea.relatedIdeaIds.includes(ideas[index === 0 ? 1 : 0].id)
      )
        throw new AppError(
          "LINK_LIMIT",
          "This idea has too many related links for one safe Notion update.",
          409,
        );
      if (idea.relatedIdeaIds.length > 100)
        throw new AppError(
          "LINK_LIMIT",
          "This idea has too many related links for this workflow.",
          409,
        );
    }
    if (
      ideas[0].relatedIdeaIds.includes(ideas[1].id) &&
      ideas[1].relatedIdeaIds.includes(ideas[0].id)
    )
      throw new AppError(
        "ALREADY_LINKED",
        "These ideas are already linked in both directions.",
        409,
      );
    return ideas;
  }
  private async snapshot(ideas: Awaited<ReturnType<LinkService["checked"]>>) {
    return (await Promise.all(
      ideas.map(async (idea) => ({
        id: idea.id,
        revision: idea.revision,
        contentHash: await linkContentHash(idea),
        related: idea.relatedIdeaIds,
      })),
    )) as LinkJournal["before"];
  }
  async prepare(input: LinkCommand, actor: string) {
    const command = linkCommandSchema.parse(input),
      ideas = await this.checked(command),
      receipt = await this.operations.issue(
        actor,
        await digest(JSON.stringify(command)),
        "related-link",
        await pairKey(command.candidateId, command.matchingId),
        await digest(JSON.stringify(await this.snapshot(ideas))),
      );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: [
        ...ideas.map((idea, index) => ({
          field: idea.title + " · " + idea.id,
          before: idea.relatedIdeaIds.join("\n") || "No related links",
          after: [
            ...new Set([...idea.relatedIdeaIds, ideas[index === 0 ? 1 : 0].id]),
          ].join("\n"),
        })),
        { field: "Reason", before: "", after: command.reason },
        {
          field: "Scope",
          before: "",
          after:
            "Add a related link in both directions and an approved intent journal. Preserve existing links, descriptions, scores, sources and evaluation history. Notion saves each side separately; a partial save can be checked and explicitly resumed.",
        },
      ],
    };
  }
  private async verifiedJournal(op: Operation, actor: string) {
    const saved = await this.repository.findJournal(op.id);
    if (!saved) return null;
    if (
      saved.journal.actor !== actor ||
      saved.journal.payloadHash !== op.payload_hash ||
      (await digest(JSON.stringify(saved.journal.before))) !==
        op.expected_revision ||
      (await digest(JSON.stringify(saved.journal.command))) !==
        op.payload_hash ||
      (await pairKey(
        saved.journal.command.candidateId,
        saved.journal.command.matchingId,
      )) !== op.target
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The saved link journal does not match this approval.",
        409,
      );
    return saved;
  }
  async execute(input: LinkCommand, token: string, actor: string) {
    const command = linkCommandSchema.parse(input),
      op = await this.operations.read(token, actor),
      hash = await digest(JSON.stringify(command));
    if (op.action !== "related-link" || op.payload_hash !== hash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The link changed. Review it again.",
        409,
      );
    if (op.status === "done") return { ideaId: op.result_id, replayed: true };
    await this.operations.claim(op, hash, [
      command.candidateId,
      command.matchingId,
    ]);
    let attempted = false;
    try {
      const ideas = await this.checked(command);
      const journal: LinkJournal = {
        format: "idea-lab-related-link",
        version: 1,
        operation: op.id,
        payloadHash: hash,
        command,
        actor,
        before: await this.snapshot(ideas),
      };
      if (
        (await digest(JSON.stringify(journal.before))) !== op.expected_revision
      )
        throw new AppError(
          "STALE_IDEA",
          "The approved link inputs changed. Review them again.",
          409,
        );
      attempted = true;
      await this.repository.appendJournal(journal);
      await this.repository.apply(journal, 0);
      await this.repository.apply(journal, 1);
      await this.operations.finish(op.id, "done", command.candidateId);
      return { ideaId: command.candidateId, replayed: false };
    } catch (error) {
      const uncertain = attempted;
      try {
        await this.operations.finish(op.id, uncertain ? "uncertain" : "failed");
      } catch {}
      if (uncertain)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The related link is not fully confirmed. Check this save before another attempt.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  async reconcileToken(token: string, actor: string) {
    return this.reconcile((await this.operations.read(token, actor)).id, actor);
  }
  async reconcile(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (op.action !== "related-link")
      throw new AppError(
        "INVALID_OPERATION",
        "This is not a related link.",
        400,
      );
    if (op.status === "done")
      return { status: "done", ideaId: op.result_id, canResume: false };
    if (!["running", "uncertain"].includes(op.status))
      return { status: op.status, canResume: false };
    const saved = await this.verifiedJournal(op, actor);
    if (!saved)
      return {
        status: op.status,
        canResume: false,
        message:
          "No confirmed intent journal. Inspect Notion before another save.",
      };
    const states = await Promise.all([
      this.repository.state(saved.journal, 0),
      this.repository.state(saved.journal, 1),
    ]);
    if (states.every((s) => s.applied)) {
      await this.operations.finish(
        op.id,
        "done",
        saved.journal.command.candidateId,
      );
      return {
        status: "done",
        ideaId: saved.journal.command.candidateId,
        canResume: false,
      };
    }
    return {
      status: op.status,
      canResume: op.status === "uncertain",
      completedSides: states.filter((s) => s.applied).length,
    };
  }
  async resume(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (op.action !== "related-link")
      throw new AppError(
        "INVALID_OPERATION",
        "This is not a related link.",
        400,
      );
    if (op.status === "done") return { status: "done", ideaId: op.result_id };
    const saved = await this.verifiedJournal(op, actor);
    if (!saved)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "No confirmed journal. Inspect Notion before retrying.",
        409,
      );
    // Check both records before claiming recovery. Never silently adopt external edits.
    await this.repository.state(saved.journal, 0);
    await this.repository.state(saved.journal, 1);
    await this.operations.resume(op, [
      saved.journal.command.candidateId,
      saved.journal.command.matchingId,
    ]);
    try {
      await this.repository.preflight();
      await this.repository.apply(saved.journal, 0);
      await this.repository.apply(saved.journal, 1);
      await this.operations.finish(
        op.id,
        "done",
        saved.journal.command.candidateId,
      );
      return { status: "done", ideaId: saved.journal.command.candidateId };
    } catch (error) {
      try {
        await this.operations.finish(op.id, "uncertain");
      } catch {}
      throw error;
    }
  }
}
