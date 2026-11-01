import { AppError } from "../ideas/errors";
import { Operations, digest, type Operation } from "../ideas/operations";
import {
  mergeCommandSchema,
  type MergeCommand,
  type MergeJournal,
  mergeBefore,
  mergeTarget,
} from "./model";
import { MergeRepository } from "./repository";
export class MergeService {
  constructor(
    private repository: MergeRepository,
    private operations: Operations,
  ) {}
  private async checked(command: MergeCommand) {
    await this.repository.preflight();
    const refs = [
        { id: command.survivorId, revision: command.survivorRevision },
        ...command.candidates,
      ],
      ideas = [];
    for (const ref of refs) {
      const idea = await this.repository.get(ref.id);
      if (idea.canonicalIdeaId)
        throw new AppError(
          "SUPERSEDED_IDEA",
          "Choose current surviving ideas as merge inputs.",
          409,
          undefined,
          false,
          [idea.canonicalIdeaId],
        );
      if (idea.revision !== ref.revision)
        throw new AppError(
          "STALE_IDEA",
          "A merge input changed. Reload and review the merge again.",
          409,
        );
      if (idea.relatedIdeaIds.length > 100)
        throw new AppError(
          "MERGE_LINK_LIMIT",
          "An input has too many links for this merge workflow.",
          409,
        );
      ideas.push(idea);
    }
    if (
      new Set([
        ...ideas[0].relatedIdeaIds,
        ...command.candidates.map((c) => c.id),
      ]).size > 100
    )
      throw new AppError(
        "MERGE_LINK_LIMIT",
        "The survivor cannot hold all preserved-original links in one safe update.",
        409,
      );
    return ideas;
  }
  private journal(
    command: MergeCommand,
    actor: string,
    before: MergeJournal["before"],
    operation: string,
    payloadHash: string,
  ): MergeJournal {
    return {
      format: "idea-lab-merge",
      version: 1,
      command,
      actor,
      before,
      operation,
      payloadHash,
    };
  }
  async prepare(input: MergeCommand, actor: string) {
    const command = mergeCommandSchema.parse(input),
      ideas = await this.checked(command),
      before = await mergeBefore(ideas),
      hash = await digest(JSON.stringify(command));
    this.repository.journalBody(
      this.journal(command, actor, before, "0".repeat(64), hash),
      ideas,
    );
    const receipt = await this.operations.issue(
      actor,
      hash,
      "merge-ideas",
      mergeTarget(command),
      await digest(JSON.stringify(before)),
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: [
        {
          field: "Surviving idea",
          before: "",
          after:
            ideas[0].title + " · " + ideas[0].id + "\n" + ideas[0].revision,
        },
        ...ideas
          .slice(1)
          .map((i) => ({
            field: "Preserved original · " + i.title,
            before:
              i.id +
              "\n" +
              i.revision +
              "\nStatus: " +
              i.status +
              "\nCanonical idea: None",
            after:
              "Status: Archived\nCanonical idea: " +
              ideas[0].title +
              " · " +
              ideas[0].id +
              "\nKeep original description, sources, scores and evaluation history.",
          })),
        {
          field: "Survivor links to preserved originals",
          before: ideas[0].relatedIdeaIds.join("\n") || "No related links",
          after: [
            ...new Set([
              ...ideas[0].relatedIdeaIds,
              ...command.candidates.map((c) => c.id),
            ]),
          ].join("\n"),
        },
        {
          field: "Descriptions and selected score",
          before: "",
          after:
            "Keep the survivor's description, current ratings and selected evaluation. Preserve each original description and assessment on its original record; record approved snapshots in the merge journal.",
        },
        {
          field: "Sources and history",
          before: "",
          after:
            "Keep every Source and Evaluation on its original idea. The survivor's detail view combines provenance and evaluation history through canonical lineage, with original-idea links. No evaluation is reassigned or rewritten.",
        },
        { field: "Reason", before: "", after: command.reason },
        {
          field: "Partial-save recovery",
          before: "",
          after:
            "Create an approved intent journal, link originals from the survivor, then archive and redirect each candidate. Notion saves these steps separately. Check status and explicitly resume verified unfinished steps; changed inputs stop recovery.",
        },
      ],
    };
  }
  private async verified(op: Operation, actor: string) {
    const saved = await this.repository.findJournal(op.id);
    if (!saved) return null;
    const j = saved.journal;
    if (
      j.actor !== actor ||
      j.payloadHash !== op.payload_hash ||
      (await digest(JSON.stringify(j.command))) !== op.payload_hash ||
      (await digest(JSON.stringify(j.before))) !== op.expected_revision ||
      mergeTarget(j.command) !== op.target
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The merge journal differs from its original approval.",
        409,
      );
    return saved;
  }
  async execute(input: MergeCommand, token: string, actor: string) {
    const command = mergeCommandSchema.parse(input),
      hash = await digest(JSON.stringify(command)),
      op = await this.operations.read(token, actor);
    if (op.action !== "merge-ideas" || op.payload_hash !== hash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The merge changed. Review it again.",
        409,
      );
    if (op.status === "done") return { ideaId: op.result_id, replayed: true };
    await this.operations.claim(op, hash, [
      command.survivorId,
      ...command.candidates.map((c) => c.id),
    ]);
    let attempted = false;
    try {
      const ideas = await this.checked(command),
        before = await mergeBefore(ideas);
      if ((await digest(JSON.stringify(before))) !== op.expected_revision)
        throw new AppError(
          "STALE_IDEA",
          "The merge inputs changed after approval.",
          409,
        );
      const journal = this.journal(command, actor, before, op.id, hash);
      this.repository.journalBody(journal, ideas);
      attempted = true;
      await this.repository.appendJournal(journal, ideas);
      for (let n = 0; n < before.length; n++)
        await this.repository.apply(journal, n);
      await this.operations.finish(op.id, "done", command.survivorId);
      return { ideaId: command.survivorId, replayed: false };
    } catch (error) {
      try {
        await this.operations.finish(op.id, attempted ? "uncertain" : "failed");
      } catch {}
      if (attempted)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The merge is not fully confirmed. Preserve the originals and check this save before another attempt.",
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
    if (op.action !== "merge-ideas")
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an idea merge.",
        400,
      );
    if (op.status === "done")
      return { status: "done", ideaId: op.result_id, canResume: false };
    if (!["running", "uncertain"].includes(op.status))
      return { status: op.status, canResume: false };
    const saved = await this.verified(op, actor);
    if (!saved)
      return {
        status: op.status,
        canResume: false,
        message: "No confirmed merge journal. Inspect Notion before retrying.",
      };
    const states = await this.repository.states(saved.journal);
    if (states.every((s) => s.applied)) {
      await this.operations.finish(
        op.id,
        "done",
        saved.journal.command.survivorId,
      );
      return {
        status: "done",
        ideaId: saved.journal.command.survivorId,
        canResume: false,
      };
    }
    return {
      status: op.status,
      canResume: op.status === "uncertain",
      completedSteps: states.filter((s) => s.applied).length,
      totalSteps: states.length,
    };
  }
  async resume(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (op.action !== "merge-ideas")
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an idea merge.",
        400,
      );
    if (op.status === "done") return { status: "done", ideaId: op.result_id };
    const saved = await this.verified(op, actor);
    if (!saved)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "No confirmed merge journal. Inspect Notion before retrying.",
        409,
      );
    await this.repository.states(saved.journal);
    await this.operations.resume(
      op,
      saved.journal.before.map((b) => b.id),
    );
    try {
      await this.repository.preflight();
      for (let n = 0; n < saved.journal.before.length; n++)
        await this.repository.apply(saved.journal, n);
      await this.operations.finish(
        op.id,
        "done",
        saved.journal.command.survivorId,
      );
      return { status: "done", ideaId: saved.journal.command.survivorId };
    } catch (error) {
      try {
        await this.operations.finish(op.id, "uncertain");
      } catch {}
      throw error;
    }
  }
}
