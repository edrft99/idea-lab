import { AppError } from "../ideas/errors";
import { commandSchema, editable, type IdeaCommand } from "../ideas/domain";
import {
  IdeaService,
  reviewIdeaCommand,
  type ImportWriteSteps,
} from "../ideas/service";
import { Operations, digest } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { sourceKey, sourceRevision } from "./provenance";
import { verifySelectedNotionSource } from "./notion-collector";
import { ImportJobStore } from "./job-store";
import { importCommand } from "./job-model";

export class ImportJobService {
  private ideas: IdeaService;
  constructor(
    readonly store: ImportJobStore,
    private repository: NotionRepository,
    private operations: Operations,
  ) {
    this.ideas = new IdeaService(repository, operations);
  }
  private async command(
    id: string,
    itemId: string,
    actor: string,
    input: unknown,
  ) {
    const command = importCommand.parse(input);
    if (command.action !== "create" || !command.source)
      throw new AppError(
        "INVALID_IMPORT",
        "Choose a source-backed create proposal.",
        400,
      );
    const item = await this.store.item(id, itemId, actor);
    if (
      (await sourceKey(command.source)) !== item.source_key ||
      (await sourceRevision(command.source)) !== item.source_revision
    )
      throw new AppError(
        "IMPORT_SOURCE_CHANGED",
        "This draft's source differs from the job manifest. Restore the matching private review file or start a new job.",
        409,
      );
    return { command, item };
  }
  async prepare(id: string, itemId: string, actor: string, input: unknown) {
    await this.store.active(id, actor);
    const { command, item } = await this.command(id, itemId, actor, input);
    this.store.available(item, ["waiting", "review", "failed"]);
    const receipt = await this.ideas.prepare(command, actor),
      op = await this.operations.read(receipt.approvalToken, actor);
    await this.store.bind(id, itemId, actor, op.id);
    return receipt;
  }
  private steps(id: string, itemId: string, hash: string): ImportWriteSteps {
    return {
      isCurrent: () => this.store.isCurrent(id, itemId, hash),
      beforeIdea: () =>
        this.store.beforeWrite(id, itemId, hash, "idea_dispatched"),
      ideaConfirmed: (idea) =>
        this.store.receipt(id, itemId, hash, "idea_confirmed", idea),
      beforeSource: () =>
        this.store.beforeWrite(id, itemId, hash, "source_dispatched"),
      sourceConfirmed: (source) =>
        this.store.receipt(id, itemId, hash, "source_confirmed", source),
      rejected: (step, error) =>
        this.store.rejected(id, itemId, hash, step, error),
    };
  }
  async commit(
    id: string,
    itemId: string,
    actor: string,
    input: unknown,
    token: string,
  ) {
    const { command, item } = await this.command(id, itemId, actor, input),
      op = await this.operations.read(token, actor);
    if (
      op.action !== "import-create" ||
      op.id !== item.operation_id ||
      op.payload_hash !== (await digest(JSON.stringify(command)))
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "The exact import review does not match this item.",
        409,
      );
    if (item.status === "done" && item.idea_id)
      return { idea: await this.repository.get(item.idea_id), replayed: true };
    if (op.status !== "pending" || op.expires_at < Date.now())
      throw new AppError(
        "IMPORT_CHECK_REQUIRED",
        "This approval was consumed or expired. Check the item before reviewing again.",
        409,
      );
    const lease = await this.store.claim(id, itemId, actor, op.id, "review");
    try {
      const result = await this.ideas.executeImported(
        command,
        op.id,
        actor,
        this.steps(id, itemId, lease.hash),
      );
      await this.store.settle(id, itemId, lease.hash, "done", result.idea.id);
      return result;
    } catch (error) {
      const current = await this.operations.readById(op.id, actor);
      await this.store.settle(
        id,
        itemId,
        lease.hash,
        current.status === "done"
          ? "done"
          : ["running", "uncertain"].includes(current.status)
            ? "check"
            : "failed",
        current.result_id,
        error,
      );
      throw error;
    }
  }
  async inspect(id: string, itemId: string, actor: string) {
    const item = await this.store.item(id, itemId, actor);
    if (
      !item.operation_id ||
      !["running", "check", "done"].includes(item.status)
    )
      return this.store.view(id, actor);
    if (item.lease_until > Date.now()) return this.store.view(id, actor);
    const op = await this.operations.readById(item.operation_id, actor);
    if (op.status === "pending" && item.phase === "not_started") {
      await this.store.expireUnclaimed(id, itemId, op.id);
      return this.store.view(id, actor);
    }
    const idea = await this.repository.findOperation(op.id),
      source = await this.repository.importedSourceByKey(item.source_key);
    if (
      source &&
      (!idea ||
        source.operation !== op.id ||
        source.revision !== item.source_revision ||
        source.source.ideaIds.length !== 1 ||
        source.source.ideaIds[0] !== idea.id)
    )
      throw new AppError(
        "IMPORT_CANONICAL_CONFLICT",
        "The canonical source or idea differs from this import. Inspect it before further work.",
        409,
        undefined,
        true,
        source.source.ideaIds,
      );
    if (idea && source) {
      await this.operations.finish(op.id, "done", idea.id);
      await this.store.checked(id, itemId, {
        done: true,
        ideaId: idea.id,
        ideaRevision: idea.revision,
        sourceId: source.source.id,
      });
    } else {
      await this.store.checked(id, itemId, {
        ...(idea ? { ideaId: idea.id, ideaRevision: idea.revision } : {}),
      });
    }
    return this.store.view(id, actor);
  }
  private async recoverable(
    id: string,
    itemId: string,
    actor: string,
    input: unknown,
  ) {
    await this.store.active(id, actor);
    const { command } = await this.command(id, itemId, actor, input);
    await this.inspect(id, itemId, actor);
    const item = await this.store.item(id, itemId, actor);
    this.store.available(item, ["check"]);
    if (
      !item.operation_id ||
      ![
        "not_started",
        "idea_rejected",
        "idea_confirmed",
        "source_rejected",
      ].includes(item.phase)
    )
      throw new AppError(
        "IMPORT_OUTCOME_AMBIGUOUS",
        "No safe missing step is proven. Check again or inspect the Notion operation; a dispatched write will not be replayed.",
        409,
        undefined,
        true,
      );
    const op = await this.operations.readById(item.operation_id, actor);
    if (
      op.action !== "import-create" ||
      op.target !== item.source_key ||
      op.payload_hash !== (await digest(JSON.stringify(command))) ||
      !["uncertain", "running"].includes(op.status)
    )
      throw new AppError(
        "IMPORT_REVIEW_CHANGED",
        "Restore the exact approved draft and check its original operation before recovery.",
        409,
      );
    const idea = item.idea_id ? await this.repository.get(item.idea_id) : null;
    if (!idea && !["not_started", "idea_rejected"].includes(item.phase))
      throw new AppError(
        "IMPORT_OUTCOME_AMBIGUOUS",
        "The original idea outcome is not confirmed. Inspect the operation before another write.",
        409,
        undefined,
        true,
      );
    if (
      idea &&
      (idea.revision !== item.idea_revision ||
        JSON.stringify(editable(idea)) !== JSON.stringify(command.data) ||
        idea.canonicalIdeaId)
    )
      throw new AppError(
        "STALE_IDEA",
        "The partially imported idea changed. Inspect it instead of attaching stale provenance.",
        409,
      );
    await verifySelectedNotionSource(this.repository, command.source!);
    if (await this.repository.importedSourceState(command.source!))
      throw new AppError(
        "IMPORT_CHECK_REQUIRED",
        "The source now exists. Check status before any recovery.",
        409,
      );
    return { command, item, op, idea };
  }
  async prepareRecovery(
    id: string,
    itemId: string,
    actor: string,
    input: unknown,
  ) {
    const r = await this.recoverable(id, itemId, actor, input);
    const receipt = await this.operations.issue(
      actor,
      r.op.payload_hash,
      "import-recover",
      r.op.id,
      r.idea?.revision ?? null,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      action: r.idea ? "import-recover" : "import-recover-create",
      changes: r.idea
        ? [
            {
              field: "Existing idea",
              before: r.idea.title,
              after: "Preserve this idea; finish only its missing source.",
            },
            ...reviewIdeaCommand(null, r.command).filter(
              (c) => c.field === "Source provenance",
            ),
          ]
        : [
            {
              field: "Stopped import",
              before: "No idea write was dispatched.",
              after: "Resume the exact reviewed idea and its selected source.",
            },
            ...reviewIdeaCommand(null, r.command),
          ],
    };
  }
  async recover(
    id: string,
    itemId: string,
    actor: string,
    input: unknown,
    token: string,
  ) {
    const r = await this.recoverable(id, itemId, actor, input),
      approval = await this.operations.read(token, actor);
    if (
      approval.action !== "import-recover" ||
      approval.target !== r.op.id ||
      approval.expected_revision !== (r.idea?.revision ?? null) ||
      approval.payload_hash !== r.op.payload_hash
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "This recovery approval does not match the exact missing source and current idea.",
        409,
      );
    const lease = await this.store.claim(id, itemId, actor, r.op.id, "check"),
      steps = this.steps(id, itemId, lease.hash);
    let approvalClaimed = false;
    try {
      const claimed = await this.store.db
        .prepare(
          "UPDATE idea_lab_operations SET status='running' WHERE id=? AND action='import-recover' AND status='pending' AND payload_hash=? AND actor_hash=? AND expires_at>=? RETURNING id",
        )
        .bind(approval.id, r.op.payload_hash, await digest(actor), Date.now())
        .first();
      if (!claimed)
        throw new AppError(
          "APPROVAL_EXPIRED",
          "Review this exact recovery again before saving.",
          409,
        );
      approvalClaimed = true;
      // The job lease fences the prior worker before converting a stopped running step.
      if (r.op.status === "running")
        await this.store.db
          .prepare(
            "UPDATE idea_lab_operations SET status='uncertain' WHERE id=? AND action='import-create' AND status='running'",
          )
          .bind(r.op.id)
          .run();
      const original = await this.operations.readById(r.op.id, actor);
      await this.operations.resume(original);
      if (!r.idea) {
        const result = await this.ideas.executeImported(
          r.command,
          r.op.id,
          actor,
          steps,
          true,
        );
        await this.operations.finish(approval.id, "done", result.idea.id);
        await this.store.settle(id, itemId, lease.hash, "done", result.idea.id);
        return result;
      }
      let source;
      try {
        source = await this.repository.importSource(
          r.idea,
          r.op.id,
          r.command.source!,
          undefined,
          undefined,
          steps.beforeSource,
        );
        await steps.sourceConfirmed(source);
      } catch (error) {
        await steps.rejected("source", error);
        throw error;
      }
      const idea = await this.repository.get(r.idea.id);
      await this.operations.finish(r.op.id, "done", idea.id);
      await this.operations.finish(approval.id, "done", idea.id);
      await this.store.settle(id, itemId, lease.hash, "done", idea.id);
      return { idea, replayed: false };
    } catch (error) {
      if (approvalClaimed) {
        if (await steps.isCurrent())
          await this.operations.finish(r.op.id, "uncertain");
        await this.operations.finish(approval.id, "failed");
      }
      await this.store.settle(
        id,
        itemId,
        lease.hash,
        "check",
        r.idea?.id ?? null,
        error,
      );
      throw error;
    }
  }
}
