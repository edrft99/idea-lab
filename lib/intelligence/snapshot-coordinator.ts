import { AppError } from "../ideas/errors";
import { digest, type Operation } from "../ideas/operations";
import { SemanticCoordinator, type SemanticStatus } from "./semantic-service";
import { cacheLock } from "./semantic-cache";
import {
  snapshotChoiceSchema,
  snapshotPlanSchema,
  snapshotPlanContext,
  snapshotActivationContext,
  snapshotDiscardContext,
  type SnapshotChoice,
} from "./snapshot-model";
import type { Snapshot } from "./snapshot-store";
export class SnapshotCoordinator extends SemanticCoordinator {
  async status(op: Operation, actor: string): Promise<SemanticStatus> {
    if (op.actor_hash !== (await digest(actor))) return super.status(op, actor);
    if (
      ["running", "uncertain", "failed"].includes(op.status) &&
      op.target === (await cacheLock(actor))
    ) {
      let context: unknown;
      try {
        context = JSON.parse(op.expected_revision ?? "null");
      } catch {}
      let result: string | null = null,
        verified = false;
      if (op.action === "semantic-snapshot-plan") {
        const c = snapshotPlanContext.safeParse(context);
        if (c.success)
          try {
            const row = await this.cache.snapshots.read(actor, op.id, true);
            const command = snapshotPlanSchema.parse({
              scope: "all-current-canonical-ideas",
              fields: row.fields,
            });
            verified =
              row.manifest_hash === c.data.manifest &&
              row.logical_profile === c.data.profile &&
              row.context_hash === c.data.context &&
              row.records.length === c.data.count &&
              op.payload_hash === (await digest(JSON.stringify(command)));
            result = row.id;
          } catch {}
      } else if (op.action === "semantic-snapshot-activate") {
        const c = snapshotActivationContext.safeParse(context);
        if (c.success) {
          const ref = await this.cache.snapshots.reference(actor);
          verified =
            ref?.snapshot_id === c.data.snapshotId &&
            ref?.operation_id === op.id;
          result = c.data.snapshotId;
        }
      } else if (op.action === "semantic-snapshot-discard") {
        const c = snapshotDiscardContext.safeParse(context);
        if (c.success) {
          const state = await this.cache.snapshots.fingerprint(
              actor,
              c.data.snapshotId,
              c.data.cacheProfile,
            ),
            ref = await this.cache.snapshots.reference(actor);
          verified =
            !state.row &&
            !state.count &&
            ref?.snapshot_id !== c.data.snapshotId;
          result = c.data.snapshotId;
        }
      } else if (op.action === "semantic-clear") {
        const state = await this.cache.fingerprint(actor);
        verified = !state.count && !state.snapshotCount && !state.active;
      }
      if (
        verified &&
        (await this.operations.confirmSemanticDerived(op.id, op.action, result))
      )
        return {
          status: "done",
          resultRetained: true,
          canResume: false,
          message:
            "The derived operation's retained postcondition was verified without replaying model or Notion requests.",
        };
    }
    return super.status(op, actor);
  }
  async list(actor: string) {
    await this.cache.purgeExpired(actor);
    const snapshots = await this.cache.snapshots.list(actor),
      reference = await this.cache.snapshots.reference(actor),
      items = [];
    for (const snapshot of snapshots) {
      const rows = await this.cache.rawRows(
          actor,
          snapshot.cache_profile,
          true,
        ),
        planned = new Map(snapshot.records.map((r) => [r.id, r])),
        ready: { idea_id: string; model: string }[] = [];
      let invalid = 0;
      for (const row of rows)
        try {
          const checked = await this.cache.checked(row),
            record = planned.get(row.idea_id);
          if (
            !record ||
            record.inputHash !== row.input_hash ||
            record.revision !== row.input_revision ||
            row.dimensions !== snapshot.descriptor.dimensions ||
            JSON.stringify(checked.fields) !==
              JSON.stringify(snapshot.fields) ||
            row.expires_at <= Date.now() ||
            row.expires_at > snapshot.expires_at
          )
            throw new Error("Invalid staged row");
          ready.push({ idea_id: checked.idea_id, model: checked.model });
        } catch {
          invalid++;
        }
      const uniform = new Set(ready.map((r) => r.model)).size <= 1;
      items.push({
        id: snapshot.id,
        descriptor: snapshot.descriptor,
        fields: snapshot.fields,
        manifestHash: snapshot.manifest_hash,
        records: snapshot.records.map((r) => ({
          id: r.id,
          ready: ready.some((v) => v.idea_id === r.id),
        })),
        total: snapshot.records.length,
        built: ready.length,
        invalid,
        complete:
          uniform && !invalid && ready.length === snapshot.records.length,
        active: reference?.snapshot_id === snapshot.id,
        model: uniform ? (ready[0]?.model ?? null) : null,
        createdAt: new Date(snapshot.created_at).toISOString(),
        expiresAt: new Date(snapshot.expires_at).toISOString(),
      });
    }
    return {
      snapshots: items,
      activeSnapshotId: reference?.snapshot_id ?? null,
      activeUnavailable:
        !!reference && !items.some((s) => s.id === reference.snapshot_id),
      capacity: { snapshots: 3, vectors: 3000 },
    };
  }
  protected async editable(actor: string, snapshot: Snapshot) {
    if (
      (await this.cache.snapshots.reference(actor))?.snapshot_id === snapshot.id
    )
      throw new AppError(
        "SEMANTIC_SNAPSHOT_ACTIVE",
        "An active snapshot is immutable. Build a replacement; discard is limited to inactive snapshots.",
        409,
      );
  }
  async prepareDiscard(input: SnapshotChoice, actor: string) {
    const command = snapshotChoiceSchema.parse(input),
      snapshot = await this.cache.snapshots.read(
        actor,
        command.snapshotId,
        true,
      );
    await this.editable(actor, snapshot);
    const state = await this.cache.snapshots.fingerprint(
        actor,
        snapshot.id,
        snapshot.cache_profile,
      ),
      context = snapshotDiscardContext.parse({
        snapshotId: snapshot.id,
        cacheProfile: snapshot.cache_profile,
        fingerprint: state.hash,
      }),
      r = await this.operations.issue(
        actor,
        await digest(JSON.stringify(command)),
        "semantic-snapshot-discard",
        await cacheLock(actor),
        JSON.stringify(context),
      );
    return {
      approvalToken: r.token,
      expiresAt: new Date(r.expires).toISOString(),
      command,
      changes: [
        {
          field: "Inactive derived snapshot",
          before: snapshot.id + " · " + state.count + " vectors",
          after:
            "Discard only this inactive manifest and its vectors. The active pointer and canonical Notion content/scores remain intact. Rebuilding requires new model transmission consent.",
        },
      ],
    };
  }
  async discard(input: SnapshotChoice, token: string, actor: string) {
    const command = snapshotChoiceSchema.parse(input),
      op = await this.operations.read(token, actor),
      payload = await digest(JSON.stringify(command));
    if (
      op.action !== "semantic-snapshot-discard" ||
      op.target !== (await cacheLock(actor)) ||
      op.payload_hash !== payload
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "This is not an approval for the selected inactive snapshot.",
        409,
      );
    if (op.status === "done")
      return { status: "done", snapshotId: command.snapshotId };
    const context = snapshotDiscardContext.parse(
      JSON.parse(op.expected_revision ?? "null"),
    );
    if (context.snapshotId !== command.snapshotId)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The snapshot changed. Review discarding it again.",
        409,
      );
    await this.operations.claim(op, payload);
    try {
      const snapshot = await this.cache.snapshots.read(
        actor,
        command.snapshotId,
        true,
      );
      await this.editable(actor, snapshot);
      if (
        snapshot.cache_profile !== context.cacheProfile ||
        (
          await this.cache.snapshots.fingerprint(
            actor,
            snapshot.id,
            snapshot.cache_profile,
          )
        ).hash !== context.fingerprint
      )
        throw new AppError(
          "STALE_SEMANTIC_CACHE",
          "The snapshot changed. Review discarding it again.",
          409,
        );
      await this.cache.snapshots.discard(actor, snapshot, op.id);
      if (!(await this.operations.finishRunning(op.id, "done", snapshot.id)))
        throw new AppError(
          "SEMANTIC_CANCELLED",
          "The derived operation was cancelled; check retained state.",
          409,
        );
      return { status: "done", snapshotId: snapshot.id };
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
}
