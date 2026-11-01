import { verifyAIExtraction } from "../intelligence/extraction-service";
import { AppError } from "../ideas/errors";
import { Operations, digest, type Operation } from "../ideas/operations";
import { editable, type Idea } from "../ideas/domain";
import { sourceKey, sourceRevision } from "../imports/provenance";
import { verifySelectedNotionSource } from "../imports/notion-collector";
import {
  storeProposalSchema,
  proposalDecisionSchema,
  type StoreProposal,
  type StoredProposal,
  type ProposalDecision,
  type ProposalIntent,
} from "./model";
import { ProposalRepository } from "./repository";
export class ProposalService {
  constructor(
    private repository: ProposalRepository,
    private operations: Operations,
  ) {}
  private async available(command: StoreProposal, actor: string) {
    if (command.ai) {
      await verifyAIExtraction(command.ai, this.operations, actor);
      if (
        JSON.stringify(command.ai.input.source) !==
        JSON.stringify(command.source)
      )
        throw new AppError(
          "AI_PROVENANCE_INVALID",
          "The selected source differs from the confirmed extraction. Review the matching source and result.",
          409,
        );
    }
    await this.repository.preflight();
    await verifySelectedNotionSource(this.repository, command.source);
    const captured = await this.repository.importedSourceState(command.source);
    if (captured)
      throw new AppError(
        "SOURCE_ALREADY_IMPORTED",
        "This source already has canonical provenance. Inspect its idea before proposing another capture.",
        409,
        undefined,
        false,
        captured.source.ideaIds,
      );
    const key = await sourceKey(command.source),
      revision = await sourceRevision(command.source),
      hint = await this.operations.latestResult(actor, "proposal-store", key),
      history = await this.repository.history(key, hint);
    const same = history.filter((p) => p.snapshot.sourceRevision === revision),
      pending = same.find((p) => p.status === "Pending");
    if (pending)
      throw new AppError(
        "PROPOSAL_ALREADY_QUEUED",
        "This source revision already has a pending proposal. Open it instead of creating another.",
        409,
        undefined,
        false,
        [],
        [pending.id],
      );
    const approved = same.find((p) => p.status === "Approved");
    if (approved)
      throw new AppError(
        "PROPOSAL_ALREADY_APPROVED",
        "This source revision was already approved. Inspect the saved result before another capture.",
        409,
        undefined,
        false,
        approved.canonicalIdeaId ? [approved.canonicalIdeaId] : [],
        [approved.id],
      );
    const rejected = same.find((p) => p.status === "Rejected");
    if (rejected && !command.reconsider)
      throw new AppError(
        "PROPOSAL_REJECTED",
        "This selected source revision was rejected. Explicitly reconsider it with a reason to save another proposal.",
        409,
        undefined,
        false,
        [],
        [rejected.id],
      );
    return { key, revision, rejected };
  }
  private snapshot(
    command: StoreProposal,
    actor: string,
    operation: string,
    hash: string,
    key: string,
    revision: string,
  ): StoredProposal {
    return {
      format: "idea-lab-extraction-proposal",
      version: 1,
      operation,
      actor,
      command,
      commandHash: hash,
      sourceKey: key,
      sourceRevision: revision,
      createdAt: new Date().toISOString(),
    };
  }
  async prepareStore(input: StoreProposal, actor: string) {
    const command = storeProposalSchema.parse(input),
      context = await this.available(command, actor),
      hash = await digest(JSON.stringify(command));
    this.repository.body(
      this.snapshot(
        command,
        actor,
        "0".repeat(64),
        hash,
        context.key,
        context.revision,
      ),
    );
    const receipt = await this.operations.issue(
      actor,
      hash,
      "proposal-store",
      context.key,
      context.revision,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      action: "proposal-store",
      changes: [
        {
          field: "Scope",
          before: "Browser-only draft",
          after:
            "Save one Pending extraction proposal in Notion Review Queue. No canonical idea or source record is created. Final approval or rejection is separate.",
        },
        ...Object.entries(command.data).map(([field, value]) => ({
          field,
          before: "",
          after: value,
        })),
        {
          field: "Selected evidence",
          before: "",
          after: command.source.evidence,
        },
        {
          field: "Provenance",
          before: "",
          after:
            command.source.system +
            " · " +
            command.source.locator +
            "\nSource revision: " +
            context.revision,
        },
        { field: "Queue note", before: "", after: command.note },
        ...(command.ai
          ? [
              {
                field: "AI origin and original result",
                before: "",
                after:
                  command.ai.resolvedModel +
                  " · deployment " +
                  command.ai.deployment +
                  " · prompt " +
                  command.ai.promptVersion +
                  "\nClassification: " +
                  command.ai.classification +
                  " · " +
                  command.ai.confidence +
                  " confidence\n" +
                  command.ai.rationale +
                  "\n" +
                  JSON.stringify(command.ai.data, null, 2),
              },
              {
                field: "Human classification override",
                before: "",
                after:
                  command.aiOverrideReason ??
                  "Not required; Idea classification.",
              },
            ]
          : []),
        ...(context.rejected
          ? [
              {
                field: "Prior rejection",
                before: context.rejected.id,
                after:
                  "Preserve the rejection and append an explicitly reconsidered proposal.\n" +
                  command.reconsiderReason,
              },
            ]
          : []),
      ],
    };
  }
  async store(input: StoreProposal, token: string, actor: string) {
    const command = storeProposalSchema.parse(input),
      hash = await digest(JSON.stringify(command)),
      op = await this.operations.read(token, actor);
    if (op.action !== "proposal-store" || op.payload_hash !== hash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The proposal changed. Review its storage scope again.",
        409,
      );
    if (op.status === "done") return { reviewId: op.result_id, replayed: true };
    await this.operations.claim(op, hash);
    let attempted = false;
    try {
      const c = await this.available(command, actor);
      if (c.key !== op.target || c.revision !== op.expected_revision)
        throw new AppError(
          "APPROVAL_CHANGED",
          "The selected source changed.",
          409,
        );
      const snapshot = this.snapshot(
        command,
        actor,
        op.id,
        hash,
        c.key,
        c.revision,
      );
      attempted = true;
      const saved = await this.repository.appendProposal(snapshot);
      await this.operations.finish(op.id, "done", saved.id);
      return { reviewId: saved.id, replayed: false };
    } catch (error) {
      try {
        await this.operations.finish(op.id, attempted ? "uncertain" : "failed");
      } catch {}
      if (attempted)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The proposal save could not be confirmed. Check Recent Saves before another request.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  private async checkedDecision(command: ProposalDecision) {
    const row = await this.repository.proposal(command.proposalId);
    if (row.status !== "Pending" || row.revision !== command.proposalRevision)
      throw new AppError(
        "STALE_PROPOSAL",
        "This proposal changed or was resolved. Reload it before another decision.",
        409,
      );
    if (command.decision === "Approve") {
      await verifySelectedNotionSource(
        this.repository,
        row.snapshot.command.source,
      );
      const captured = await this.repository.importedSourceState(
        row.snapshot.command.source,
      );
      if (captured)
        throw new AppError(
          "SOURCE_ALREADY_IMPORTED",
          "This source already has canonical provenance. Inspect that result; do not create another idea.",
          409,
          undefined,
          false,
          captured.source.ideaIds,
        );
    }
    return row;
  }
  private async contextHash(revision: string, proposal: StoredProposal) {
    return digest(
      JSON.stringify([revision, await digest(JSON.stringify(proposal))]),
    );
  }
  async prepareDecision(input: ProposalDecision, actor: string) {
    const command = proposalDecisionSchema.parse(input),
      row = await this.checkedDecision(command),
      hash = await digest(JSON.stringify(command));
    this.repository.body({
      format: "idea-lab-extraction-decision",
      version: 1,
      operation: "0".repeat(64),
      actor,
      command,
      payloadHash: hash,
      proposal: row.snapshot,
      createdAt: new Date().toISOString(),
    });
    const receipt = await this.operations.issue(
      actor,
      hash,
      "proposal-" + command.decision.toLowerCase(),
      "review:" + row.id,
      await this.contextHash(row.revision, row.snapshot),
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      action: command.decision === "Approve" ? "create" : "proposal-reject",
      changes: [
        {
          field: "Saved proposal",
          before: row.id,
          after:
            row.snapshot.command.data.title + "\nRevision: " + row.revision,
        },
        {
          field: "Selected evidence",
          before: "",
          after: row.snapshot.command.source.evidence,
        },
        ...(row.snapshot.command.ai
          ? [
              {
                field: "Preserved AI classification and human override",
                before: "",
                after:
                  row.snapshot.command.ai.classification +
                  " · " +
                  row.snapshot.command.ai.resolvedModel +
                  " · " +
                  row.snapshot.command.ai.promptVersion +
                  "\n" +
                  row.snapshot.command.ai.rationale +
                  "\nHuman override: " +
                  (row.snapshot.command.aiOverrideReason ?? "Not required") +
                  "\nOriginal AI suggestion: " +
                  JSON.stringify(row.snapshot.command.ai.data, null, 2),
              },
            ]
          : []),
        ...(command.decision === "Approve"
          ? Object.entries(command.data).map(([field, value]) => ({
              field,
              before: String(
                row.snapshot.command.data[field as keyof typeof command.data],
              ),
              after: value,
            }))
          : []),
        { field: "Decision reason", before: "", after: command.reason },
        {
          field: "Scope",
          before: "Pending",
          after:
            command.decision === "Approve"
              ? "Create one canonical idea and linked selected-source record, then resolve this proposal. Preserve the original proposal and append a decision intent. Partial capture requires status checking."
              : "Record an authoritative rejection of this selected source revision. Preserve the evidence and proposal; create no canonical idea, source or evaluation.",
        },
      ],
    };
  }
  private async intentFor(op: Operation, actor: string) {
    const saved = await this.repository.findIntent(op.id);
    if (!saved) return null;
    const j = saved.snapshot;
    if (
      j.actor !== actor ||
      j.payloadHash !== op.payload_hash ||
      (await digest(JSON.stringify(j.command))) !== op.payload_hash ||
      "review:" + j.command.proposalId !== op.target ||
      (await this.contextHash(j.command.proposalRevision, j.proposal)) !==
        op.expected_revision ||
      op.action !== "proposal-" + j.command.decision.toLowerCase()
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The extraction decision intent differs from its reviewed inputs.",
        409,
      );
    return saved;
  }
  private async captured(j: ProposalIntent): Promise<Idea | null> {
    if (j.command.decision !== "Approve") return null;
    const idea = await this.repository.findOperation(j.operation);
    if (!idea) return null;
    if (
      !idea.revision.split("@")[0].endsWith(";revision:" + j.operation) ||
      JSON.stringify(editable(idea)) !== JSON.stringify(j.command.data)
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The captured idea changed or differs from this approval. Preserve it and inspect the save.",
        409,
      );
    const source = j.proposal.command.source,
      state = await this.repository.importedSourceState(source);
    if (!state) return null;
    if (
      state.operation !== j.operation ||
      state.revision !== j.proposal.sourceRevision ||
      !state.source.ideaIds.includes(idea.id) ||
      state.source.system !== source.system ||
      state.source.summary !== source.evidence ||
      state.source.identifier !==
        source.conversationId + "/" + source.messageId ||
      state.source.url !== source.originalUrl
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The captured source cannot be verified against this approval.",
        409,
      );
    return this.repository.get(idea.id);
  }
  async decide(input: ProposalDecision, token: string, actor: string) {
    const command = proposalDecisionSchema.parse(input),
      hash = await digest(JSON.stringify(command)),
      op = await this.operations.read(token, actor);
    if (
      op.action !== "proposal-" + command.decision.toLowerCase() ||
      op.payload_hash !== hash
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The extraction decision changed. Review it again.",
        409,
      );
    if (op.status === "done")
      return {
        reviewId: command.proposalId,
        idea:
          command.decision === "Approve"
            ? await this.repository.get(op.result_id!)
            : undefined,
        replayed: true,
      };
    const before = await this.checkedDecision(command);
    if (
      (await this.contextHash(before.revision, before.snapshot)) !==
      op.expected_revision
    )
      throw new AppError("APPROVAL_CHANGED", "The stored source changed.", 409);
    await this.operations.claim(op, hash, [before.snapshot.sourceKey]);
    let attempted = false;
    try {
      const row = await this.checkedDecision(command),
        intent: ProposalIntent = {
          format: "idea-lab-extraction-decision",
          version: 1,
          operation: op.id,
          actor,
          command,
          payloadHash: hash,
          proposal: row.snapshot,
          createdAt: new Date().toISOString(),
        };
      attempted = true;
      const saved = await this.repository.appendIntent(intent);
      let idea: Idea | undefined;
      if (command.decision === "Approve") {
        await this.checkedDecision(command);
        idea = await this.repository.write(command.data, op.id, actor);
        if (
          !idea.revision.split("@")[0].endsWith(";revision:" + op.id) ||
          JSON.stringify(editable(idea)) !== JSON.stringify(command.data)
        )
          throw new AppError(
            "WRITE_UNCERTAIN",
            "The idea capture response differs from the approved fields.",
            503,
            undefined,
            true,
          );
        await this.repository.importSource(
          idea,
          op.id,
          row.snapshot.command.source,
          row.snapshot.command.ai,
          row.snapshot.command.ai
            ? {
                proposalId: row.id,
                intentId: saved.id,
                overrideReason: row.snapshot.command.aiOverrideReason ?? null,
              }
            : undefined,
        );
        const verified = await this.captured(intent);
        if (!verified)
          throw new AppError(
            "WRITE_UNCERTAIN",
            "The selected source was not confirmed.",
            503,
            undefined,
            true,
          );
        idea = verified;
      }
      await this.repository.close(saved, idea?.id ?? null);
      await this.operations.finish(op.id, "done", idea?.id ?? row.id);
      return { reviewId: row.id, idea, replayed: false };
    } catch (error) {
      try {
        await this.operations.finish(op.id, attempted ? "uncertain" : "failed");
      } catch {}
      if (attempted)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The extraction decision or capture is not fully confirmed. Check Recent Saves before another save.",
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
    if (
      !["proposal-store", "proposal-approve", "proposal-reject"].includes(
        op.action,
      )
    )
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an extraction proposal save.",
        400,
      );
    if (op.status === "done")
      return {
        status: "done",
        reviewId:
          op.action === "proposal-approve" ? op.target?.slice(7) : op.result_id,
        ideaId: op.action === "proposal-approve" ? op.result_id : null,
        canResume: false,
      };
    if (!["running", "uncertain"].includes(op.status))
      return { status: op.status, canResume: false };
    if (op.action === "proposal-store") {
      const saved = await this.repository.findStored(op.id);
      if (saved) {
        if (
          saved.snapshot.actor !== actor ||
          saved.snapshot.commandHash !== op.payload_hash ||
          saved.snapshot.sourceKey !== op.target ||
          saved.snapshot.sourceRevision !== op.expected_revision
        )
          throw new AppError(
            "RECONCILIATION_REQUIRED",
            "The saved proposal differs from its storage approval.",
            409,
          );
        await this.operations.finish(op.id, "done", saved.id);
        return {
          status: "done",
          reviewId: saved.id,
          ideaId: null,
          canResume: false,
        };
      }
      return { status: op.status, canResume: false };
    }
    const intent = await this.intentFor(op, actor);
    if (!intent) return { status: op.status, canResume: false };
    const idea = await this.captured(intent.snapshot);
    const row = await this.repository.proposal(
      intent.snapshot.command.proposalId,
    );
    if (
      row.decision?.decision === intent.snapshot.command.decision &&
      row.decision?.reason === intent.snapshot.command.reason &&
      row.decision?.operation === op.id &&
      row.decision.intentId === intent.id &&
      (intent.snapshot.command.decision === "Reject" ||
        (idea && row.canonicalIdeaId === idea.id))
    ) {
      await this.operations.finish(op.id, "done", idea?.id ?? row.id);
      return {
        status: "done",
        reviewId: row.id,
        ideaId: idea?.id ?? null,
        canResume: false,
      };
    }
    const canClose =
      row.status === "Pending" &&
      row.revision === intent.snapshot.command.proposalRevision &&
      (intent.snapshot.command.decision === "Reject" || !!idea);
    return {
      status: op.status,
      reviewId: row.id,
      ideaId: idea?.id ?? null,
      canResume: op.status === "uncertain" && canClose,
      message: canClose
        ? "The decision can finish resolving its original queue row."
        : "Canonical capture is unverified or the original changed. No capture will be replayed.",
    };
  }
  async resume(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (!["proposal-approve", "proposal-reject"].includes(op.action))
      throw new AppError(
        "INVALID_OPERATION",
        "This extraction save cannot be resumed.",
        400,
      );
    if (op.status === "done") return this.reconcile(id, actor);
    const intent = await this.intentFor(op, actor);
    if (!intent)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "No confirmed decision intent was found.",
        409,
      );
    const j = intent.snapshot,
      idea = await this.captured(j);
    if (j.command.decision === "Approve" && !idea)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The canonical capture is not fully verified. No create or source write will be replayed.",
        409,
      );
    const row = await this.repository.proposal(j.command.proposalId);
    if (row.status !== "Pending" || row.revision !== j.command.proposalRevision)
      throw new AppError(
        "STALE_PROPOSAL",
        "The original proposal changed. Check its save status.",
        409,
      );
    await this.operations.resume(op, [j.proposal.sourceKey]);
    try {
      await this.repository.close(intent, idea?.id ?? null);
      await this.operations.finish(op.id, "done", idea?.id ?? row.id);
      return { status: "done", reviewId: row.id, ideaId: idea?.id ?? null };
    } catch (error) {
      try {
        await this.operations.finish(op.id, "uncertain");
      } catch {}
      throw error;
    }
  }
}
