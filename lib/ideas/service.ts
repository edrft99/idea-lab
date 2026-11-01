import { verifySelectedNotionSource } from "../imports/notion-collector";
import { sourceKey, sourceRevision } from "../imports/provenance";
import { AppError } from "./errors";
import { digest, Operations, type Operation } from "./operations";
import {
  changes,
  editable,
  commandSchema,
  type IdeaCommand,
  type Idea,
} from "./domain";
import { NotionRepository } from "./notion";
export interface ImportWriteSteps {
  isCurrent(): Promise<boolean>;
  beforeIdea(): Promise<void>;
  ideaConfirmed(idea: Idea): Promise<void>;
  beforeSource(): Promise<void>;
  sourceConfirmed(source: { id: string }): Promise<void>;
  rejected(step: "idea" | "source", error: unknown): Promise<void>;
}
export function reviewIdeaCommand(
  before: Idea | null,
  normalized: IdeaCommand,
) {
  const source = normalized.action === "create" ? normalized.source : undefined;
  const diff = changes(before ? editable(before) : null, normalized.data);
  if (normalized.action === "create")
    diff.push({
      field: "Source provenance",
      before: "",
      after: source
        ? source.system +
          " · " +
          source.locator +
          "\nRole: " +
          source.role +
          "\nSelected evidence:\n" +
          source.evidence +
          (source.system === "Notion"
            ? "\nDocument date: "
            : "\nConversation date: ") +
          (source.conversationDate ?? "Unknown") +
          "\nOriginal URL: " +
          (source.originalUrl ?? "Unavailable") +
          (source.originRevision
            ? "\nExternal revision: " + source.originRevision
            : "")
        : "A linked manual-capture source with the summary and capture time.",
    });
  return diff;
}
export class IdeaService {
  constructor(
    private repository: NotionRepository,
    private operations: Operations,
  ) {}
  async prepare(command: IdeaCommand, actor: string) {
    const normalized = commandSchema.parse(command);
    const before =
      normalized.action === "update"
        ? await this.repository.get(normalized.id)
        : null;
    if (
      before &&
      before.revision !==
        (normalized as Extract<IdeaCommand, { action: "update" }>)
          .expectedRevision
    )
      throw new AppError(
        "STALE_IDEA",
        "This idea changed in Notion. Reload it before reviewing an update.",
        409,
      );
    if (before?.canonicalIdeaId)
      throw new AppError(
        "SUPERSEDED_IDEA",
        "This original is preserved after a merge. Edit the surviving idea.",
        409,
        undefined,
        false,
        [before.canonicalIdeaId],
      );
    const source =
      normalized.action === "create" ? normalized.source : undefined;
    if (source) {
      await verifySelectedNotionSource(this.repository, source);
      const existing = await this.repository.importedSourceState(source);
      if (existing)
        throw new AppError(
          existing.revision === (await sourceRevision(source))
            ? "SOURCE_ALREADY_IMPORTED"
            : "SOURCE_REVISION_CHANGED",
          "This source was already imported. Inspect its canonical idea before proposing a refinement.",
          409,
          undefined,
          false,
          existing.source.ideaIds,
        );
      const queued = await this.repository.extractionReviews?.(source);
      if (queued?.length)
        throw new AppError(
          "PROPOSAL_ALREADY_QUEUED",
          "This source has a saved extraction proposal. Review it before creating a canonical idea.",
          409,
          undefined,
          false,
          [],
          queued,
        );
    }
    const diff = reviewIdeaCommand(before, normalized);
    if (!diff.length)
      throw new AppError("NO_CHANGES", "There are no changes to save.", 400);
    const receipt = await this.operations.issue(
      actor,
      await digest(JSON.stringify(normalized)),
      normalized.action,
      normalized.action === "update"
        ? normalized.id
        : source
          ? await sourceKey(source)
          : null,
      normalized.action === "update" ? normalized.expectedRevision : null,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: diff,
      action: normalized.action,
    };
  }
  async execute(command: IdeaCommand, token: string, actor: string) {
    const normalized = commandSchema.parse(command),
      op = await this.operations.read(token, actor);
    return this.executeOperation(normalized, op, actor);
  }
  async executeAssistantApproved(
    command: IdeaCommand,
    id: string,
    actor: string,
  ) {
    const normalized = commandSchema.parse(command),
      op = await this.operations.readById(id, actor);
    await this.operations.requireAssistantApproval(
      id,
      actor,
      await digest(JSON.stringify(normalized)),
    );
    return this.executeOperation(normalized, op, actor);
  }
  // Only the import worker calls this after claiming its fenced lease. Native/MCP commits
  // reject import-create operations, so they cannot bypass job cancellation or attempt limits.
  async executeImported(
    command: IdeaCommand,
    operationId: string,
    actor: string,
    steps: ImportWriteSteps,
    resuming = false,
  ) {
    const normalized = commandSchema.parse(command),
      op = await this.operations.readById(operationId, actor);
    if (!(await steps.isCurrent()))
      throw new AppError(
        "IMPORT_LEASE_ENDED",
        "This import worker no longer owns the item.",
        409,
        undefined,
        true,
      );
    if (
      op.action !== "import-create" ||
      normalized.action !== "create" ||
      !normalized.source
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "This operation is not an approved import item.",
        409,
      );
    if (resuming && op.status !== "running")
      throw new AppError(
        "INVALID_APPROVAL",
        "This import has not claimed recovery.",
        409,
      );
    return this.executeOperation(
      normalized,
      { ...op, action: "create" },
      actor,
      steps,
      resuming,
    );
  }
  private async executeOperation(
    normalized: IdeaCommand,
    op: Operation,
    actor: string,
    steps?: ImportWriteSteps,
    resuming = false,
  ) {
    const payloadHash = await digest(JSON.stringify(normalized));
    if (
      op.actor_hash !== (await digest(actor)) ||
      op.action !== normalized.action ||
      (normalized.action === "update" &&
        (op.target !== normalized.id ||
          op.expected_revision !== normalized.expectedRevision))
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "This approval does not match the current capture action or owner.",
        409,
      );
    if (op.payload_hash !== payloadHash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The approved changes were edited. Review them again.",
        409,
      );
    if (op.status === "done") {
      if (!op.result_id)
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "This operation requires reconciliation.",
        );
      return { idea: await this.repository.get(op.result_id), replayed: true };
    }
    const claimed = resuming || (await this.operations.claim(op, payloadHash));
    if (!claimed)
      throw new AppError(
        "APPROVAL_USED",
        "Check the result of the prior save.",
        409,
      );
    let mutated = false;
    try {
      if (normalized.action === "update") {
        const before = await this.repository.get(normalized.id);
        if (before.canonicalIdeaId)
          throw new AppError(
            "SUPERSEDED_IDEA",
            "Edit the surviving idea.",
            409,
            undefined,
            false,
            [before.canonicalIdeaId],
          );
        if (before.revision !== normalized.expectedRevision)
          throw new AppError(
            "STALE_IDEA",
            "This idea changed after approval. Reload and review the new version.",
            409,
          );
      }
      if (normalized.action === "create" && normalized.source) {
        await verifySelectedNotionSource(this.repository, normalized.source);
        const existing = await this.repository.importedSourceState(
          normalized.source,
        );
        if (existing)
          throw new AppError(
            "SOURCE_ALREADY_IMPORTED",
            "This source has already been imported. Check its canonical record.",
            409,
            undefined,
            false,
            existing.source.ideaIds,
          );
        const queued = await this.repository.extractionReviews?.(
          normalized.source,
        );
        if (queued?.length)
          throw new AppError(
            "PROPOSAL_ALREADY_QUEUED",
            "Review the saved extraction proposal instead of creating another capture.",
            409,
            undefined,
            false,
            [],
            queued,
          );
      }
      const prior = await this.repository.findOperation(op.id);
      let idea = prior;
      if (!idea) {
        try {
          const args = [
            normalized.data,
            op.id,
            actor,
            normalized.action === "update" ? normalized.id : undefined,
            normalized.action === "update"
              ? normalized.expectedRevision
              : undefined,
          ] as const;
          idea = steps
            ? await this.repository.write(...args, steps.beforeIdea)
            : await this.repository.write(...args);
        } catch (error) {
          await steps?.rejected("idea", error);
          throw error;
        }
      }
      mutated = true;
      await steps?.ideaConfirmed(idea);
      if (normalized.action === "create") {
        if (normalized.source) {
          try {
            const source = steps
              ? await this.repository.importSource(
                  idea,
                  op.id,
                  normalized.source,
                  undefined,
                  undefined,
                  steps.beforeSource,
                )
              : await this.repository.importSource(
                  idea,
                  op.id,
                  normalized.source,
                );
            await steps?.sourceConfirmed(source);
          } catch (error) {
            await steps?.rejected("source", error);
            throw error;
          }
        } else await this.repository.manualSource(idea, op.id, payloadHash);
        const current = await this.repository.get(idea.id);
        await this.operations.finish(op.id, "done", idea.id);
        return { idea: current, replayed: Boolean(prior) };
      }
      await this.operations.finish(op.id, "done", idea.id);
      return { idea, replayed: Boolean(prior) };
    } catch (error) {
      if (steps && !(await steps.isCurrent()))
        throw new AppError(
          "IMPORT_LEASE_ENDED",
          "A newer import checkpoint owns this operation. Check its current result.",
          409,
          undefined,
          true,
        );
      const uncertain =
        mutated || !(error instanceof AppError) || error.uncertain;
      try {
        await this.operations.finish(op.id, uncertain ? "uncertain" : "failed");
      } catch {}
      if (uncertain)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The save could not be confirmed. Keep this approval and check its status; do not submit another save.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  async reconcile(token: string, actor: string) {
    return this.reconcileOperation(await this.operations.read(token, actor));
  }
  async reconcileId(id: string, actor: string) {
    return this.reconcileOperation(await this.operations.readById(id, actor));
  }
  private async reconcileOperation(op: Operation) {
    if (!["create", "update"].includes(op.action))
      throw new AppError(
        "INVALID_OPERATION",
        "Use the matching workflow to check this save.",
        400,
      );
    if (op.status === "done") return { status: "done", ideaId: op.result_id };
    if (op.status !== "uncertain" && op.status !== "running")
      return { status: op.status, ideaId: null };
    const found = await this.repository.findOperation(op.id);
    if (
      found &&
      (op.action !== "create" || (await this.repository.hasManualSource(op.id)))
    ) {
      await this.operations.finish(op.id, "done", found.id);
      return { status: "done", ideaId: found.id };
    }
    return { status: op.status, ideaId: null };
  }
}
