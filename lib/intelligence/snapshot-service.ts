import { z } from "zod";
import { AppError } from "../ideas/errors";
import { digest, type Operation } from "../ideas/operations";
import { SemanticService, type SemanticStatus } from "./semantic-service";
import { SnapshotCoordinator } from "./snapshot-coordinator";
import { semanticInput, inputVersion } from "./semantic-model";
import { embeddingProfileHash } from "./embedding-config";
import { cacheLock } from "./semantic-cache";
import {
  snapshotPlanSchema,
  snapshotBatchSchema,
  snapshotChoiceSchema,
  snapshotRecordsSchema,
  snapshotPlanContext,
  snapshotActivationContext,
  snapshotManifestHash,
  snapshotStorageProfile,
  snapshotHash,
  type SnapshotPlan,
  type SnapshotBatch,
  type SnapshotChoice,
} from "./snapshot-model";
import type { Snapshot } from "./snapshot-store";
const batchContext = z
  .object({
    version: z.literal(1),
    profile: snapshotHash,
    context: snapshotHash,
    manifest: snapshotHash,
    count: z.number().int().min(1).max(20),
    dimensions: z.number().int().min(1).max(4096),
  })
  .strict();
const changed = () =>
  new AppError(
    "SEMANTIC_SNAPSHOT_CHANGED",
    "The canonical collection or selected descriptions changed. Plan a new complete snapshot; the previous active index is preserved.",
    409,
  );
const cancelled = () =>
  new AppError(
    "SEMANTIC_CANCELLED",
    "The derived operation was cancelled or its completion was not retained. Check the actual snapshot state.",
    409,
  );
export class SnapshotService extends SemanticService {
  async status(op: Operation, actor: string): Promise<SemanticStatus> {
    return new SnapshotCoordinator(this.operations, this.cache).status(
      op,
      actor,
    );
  }
  private descriptor() {
    return {
      endpoint: this.config.endpoint,
      deployment: this.config.deployment,
      dimensions: this.config.dimensions,
      versionLabel: this.config.versionLabel,
      inputVersion,
    };
  }
  private async collection(fields: Snapshot["fields"]) {
    const ideas = (await this.repository.listSemanticIdeas()).filter(
      (i) => !i.canonicalIdeaId,
    );
    if (ideas.length > 1000)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_CAPACITY",
        "A complete snapshot currently supports at most 1,000 canonical ideas. No partial collection was planned.",
        409,
      );
    const result = [];
    for (const idea of ideas) {
      let projected;
      try {
        projected = await semanticInput(idea, fields, [
          this.config.key,
          ...this.secrets,
        ]);
      } catch {
        throw new AppError(
          "SEMANTIC_INPUT_EMPTY",
          "Every canonical idea needs content in the selected description fields. Include title or summary before planning again.",
          400,
          undefined,
          false,
          [idea.id],
        );
      }
      result.push({
        id: idea.id,
        inputHash: projected.hash,
        revision: await digest(idea.revision),
        title: idea.title,
        input: projected.input,
      });
    }
    snapshotRecordsSchema.parse(
      result.map(({ id, inputHash, revision }) => ({
        id,
        inputHash,
        revision,
      })),
    );
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  private async checkProfile(snapshot: Snapshot) {
    if (snapshot.logical_profile !== (await embeddingProfileHash(this.config)))
      throw new AppError(
        "SEMANTIC_MODEL_CHANGED",
        "This plan belongs to another pinned embedding profile. Use its matching configuration or plan a replacement.",
        409,
      );
  }
  private async editable(actor: string, snapshot: Snapshot) {
    await this.checkProfile(snapshot);
    if (
      (await this.cache.snapshots.reference(actor))?.snapshot_id === snapshot.id
    )
      throw new AppError(
        "SEMANTIC_SNAPSHOT_ACTIVE",
        "The active snapshot is immutable. Plan a complete replacement instead.",
        409,
      );
    if (snapshot.expires_at <= Date.now()) throw changed();
  }
  private async selected(snapshot: Snapshot, ids: string[]) {
    const result = [];
    for (const id of ids) {
      const planned = snapshot.records.find((r) => r.id === id);
      if (!planned)
        throw new AppError(
          "INVALID_SEMANTIC_REQUEST",
          "Choose only records in this snapshot manifest.",
          400,
        );
      const idea = await this.repository.getSemanticIdea(id);
      if (idea.canonicalIdeaId) throw changed();
      const projection = await semanticInput(idea, snapshot.fields, [
        this.config.key,
        ...this.secrets,
      ]);
      if (projection.hash !== planned.inputHash) throw changed();
      result.push({ ...planned, title: idea.title, input: projection.input });
    }
    return result;
  }
  private async ready(snapshot: Snapshot, actor: string) {
    const rows = await this.cache.rawRows(actor, snapshot.cache_profile, true),
      records = new Map(snapshot.records.map((r) => [r.id, r])),
      valid = [];
    for (const row of rows)
      try {
        const checked = await this.cache.checked(row),
          record = records.get(row.idea_id);
        if (
          !record ||
          checked.input_hash !== record.inputHash ||
          checked.input_revision !== record.revision ||
          checked.dimensions !== snapshot.descriptor.dimensions ||
          checked.expires_at <= Date.now() ||
          checked.expires_at > snapshot.expires_at ||
          JSON.stringify(checked.fields) !== JSON.stringify(snapshot.fields)
        )
          continue;
        const { values, ...metadata } = checked;
        valid.push(metadata);
      } catch {}
    return { rows, valid, models: new Set(valid.map((r) => r.model)) };
  }
  private async complete(snapshot: Snapshot, actor: string) {
    const state = await this.ready(snapshot, actor);
    if (
      state.rows.length !== snapshot.records.length ||
      state.valid.length !== snapshot.records.length ||
      (snapshot.records.length > 0 && state.models.size !== 1)
    )
      throw new AppError(
        "SEMANTIC_SNAPSHOT_INCOMPLETE",
        "Every manifest record needs a valid, unexpired vector from one compatible model before activation. No partial snapshot was activated.",
        409,
      );
    return {
      model: state.valid[0]?.model ?? null,
      vectorsHash: await digest(
        JSON.stringify(
          state.valid
            .map((r) => ({
              id: r.idea_id,
              inputHash: r.input_hash,
              revision: r.input_revision,
              fields: r.fields,
              model: r.model,
              dimensions: r.dimensions,
              vectorHash: r.vector_hash,
              operation: r.operation_id,
              updatedAt: r.updated_at,
              expiresAt: r.expires_at,
            }))
            .sort((a, b) => a.id.localeCompare(b.id)),
        ),
      ),
    };
  }
  private async current(snapshot: Snapshot) {
    const actual = await this.collection(snapshot.fields),
      planned = new Map(snapshot.records.map((r) => [r.id, r.inputHash]));
    if (
      actual.length !== snapshot.records.length ||
      actual.some((r) => planned.get(r.id) !== r.inputHash)
    )
      throw changed();
    return actual;
  }
  async preparePlan(input: SnapshotPlan, actor: string) {
    const command = snapshotPlanSchema.parse(input);
    await this.cache.purgeExpired(actor);
    if ((await this.cache.snapshots.list(actor)).length >= 3)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_CAPACITY",
        "Discard an inactive snapshot before planning another. The active index can stay in use.",
        409,
      );
    const records = await this.collection(command.fields),
      context = snapshotPlanContext.parse({
        version: 1,
        profile: await embeddingProfileHash(this.config),
        context: await this.context(),
        manifest: await snapshotManifestHash(records, command.fields),
        count: records.length,
      }),
      r = await this.operations.issue(
        actor,
        await digest(JSON.stringify(command)),
        "semantic-snapshot-plan",
        await cacheLock(actor),
        JSON.stringify(context),
      );
    return {
      approvalToken: r.token,
      expiresAt: new Date(r.expires).toISOString(),
      command,
      changes: [
        {
          field: "Complete canonical scope",
          before: "No new snapshot manifest",
          after:
            records.length +
            " current canonical ideas; fields: " +
            command.fields.join(", ") +
            "\n" +
            records.map((r) => r.title + " · " + r.id).join("\n"),
        },
        {
          field: "Derived plan only",
          before: "Current search pointer is preserved",
          after:
            "Store only IDs, field/input/version hashes and pinned model metadata. No model call or Notion write. Each batch still needs its own exact transmission approval; activation separately verifies the entire current canonical collection.",
        },
        {
          field: "Pinned profile and expiry",
          before: "",
          after:
            this.config.endpoint +
            " · " +
            this.config.deployment +
            " · " +
            this.config.versionLabel +
            " · " +
            this.config.dimensions +
            " dimensions. Planned artifacts expire no later than " +
            this.config.cacheSeconds +
            " seconds after creation; vectors share the snapshot expiry. At least " +
            Math.ceil(records.length / 20) +
            " explicitly reviewed batches are required, sharing " +
            this.config.requestsPerHour +
            " attempts per hour with other AI tasks; choose sufficient retention before beginning.",
        },
      ],
    };
  }
  async plan(input: SnapshotPlan, token: string, actor: string) {
    const command = snapshotPlanSchema.parse(input),
      op = await this.operations.read(token, actor),
      payload = await digest(JSON.stringify(command));
    if (
      op.action !== "semantic-snapshot-plan" ||
      op.target !== (await cacheLock(actor)) ||
      op.payload_hash !== payload
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "Review this complete snapshot plan again.",
        409,
      );
    if (op.status === "done")
      return { status: "done", snapshotId: op.result_id };
    const context = snapshotPlanContext.parse(
      JSON.parse(op.expected_revision ?? "null"),
    );
    if (
      context.context !== (await this.context()) ||
      context.profile !== (await embeddingProfileHash(this.config))
    )
      throw changed();
    await this.operations.claim(op, payload);
    try {
      await this.cache.purgeExpired(actor);
      const records = await this.collection(command.fields);
      if (
        records.length !== context.count ||
        (await snapshotManifestHash(records, command.fields)) !==
          context.manifest
      )
        throw changed();
      const now = Date.now();
      await this.cache.snapshots.create(
        actor,
        {
          id: op.id,
          owner_hash: await digest(actor),
          logical_profile: context.profile,
          cache_profile: await snapshotStorageProfile(op.id, context.profile),
          fields_json: JSON.stringify(command.fields),
          manifest_json: JSON.stringify(
            records.map(({ id, inputHash, revision }) => ({
              id,
              inputHash,
              revision,
            })),
          ),
          manifest_hash: context.manifest,
          descriptor_json: JSON.stringify(this.descriptor()),
          context_hash: context.context,
          created_at: now,
          expires_at: now + this.config.cacheSeconds * 1000,
        },
        op.id,
      );
      if (!(await this.operations.finishRunning(op.id, "done", op.id)))
        throw cancelled();
      return { status: "done", snapshotId: op.id };
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
  async prepareBatch(input: SnapshotBatch, actor: string) {
    let command = snapshotBatchSchema.parse(input);
    const snapshot = await this.cache.snapshots.read(actor, command.snapshotId);
    await this.editable(actor, snapshot);
    const state = await this.ready(snapshot, actor);
    if (state.models.size > 1)
      throw new AppError(
        "SEMANTIC_MODEL_CHANGED",
        "This staging snapshot mixes model versions. Discard it and plan with a pinned compatible deployment.",
        409,
      );
    const selected = await this.selected(snapshot, command.ideaIds),
      records = selected.filter(
        (r) => !state.valid.some((v) => v.idea_id === r.id),
      );
    if (!records.length)
      throw new AppError(
        "SEMANTIC_INDEX_CURRENT",
        "Those snapshot records already have valid vectors. Select remaining records; no paid request was repeated.",
        409,
      );
    if (
      (await this.cache.stats(actor)).total +
        records.filter((r) => !state.rows.some((v) => v.idea_id === r.id))
          .length >
      3000
    )
      throw new AppError(
        "SEMANTIC_CAPACITY",
        "Discard inactive snapshots before retaining more than 3,000 vectors across generations.",
        409,
      );
    command = snapshotBatchSchema.parse({
      ...command,
      ideaIds: records.map((r) => r.id),
    });
    const context = batchContext.parse({
      version: 1,
      profile: snapshot.cache_profile,
      context: await this.context(),
      manifest: await snapshotManifestHash(records, snapshot.fields),
      count: records.length,
      dimensions: this.config.dimensions,
    });
    return this.receipt(
      command,
      actor,
      "semantic-snapshot-batch",
      "semantic-snapshot-batch:" + snapshot.id,
      JSON.stringify(context),
      [
        {
          field: "Exact selected description excerpts",
          before: "",
          after: records.map((r) => r.title + "\n" + r.input).join("\n\n"),
        },
        {
          field: "Inactive snapshot batch",
          before: snapshot.id,
          after:
            "Build " +
            records.length +
            " selected vectors in this inactive snapshot only. The active search pointer stays unchanged. Each field is limited to 760 escaped JSON UTF-8 bytes. These vectors expire with the snapshot at " +
            new Date(snapshot.expires_at).toISOString() +
            ". Activation requires separate complete-manifest/current-Notion verification.",
        },
      ],
    );
  }
  async batch(
    input: SnapshotBatch,
    token: string,
    actor: string,
    signal?: AbortSignal,
  ) {
    const command = snapshotBatchSchema.parse(input),
      op = await this.operations.read(token, actor);
    if (op.action !== "semantic-snapshot-batch")
      throw new AppError(
        "INVALID_APPROVAL",
        "This is not a snapshot batch approval.",
        409,
      );
    const context = batchContext.parse(
        JSON.parse(op.expected_revision ?? "null"),
      ),
      initial = await this.cache.snapshots.read(actor, command.snapshotId);
    if (
      context.context !== (await this.context()) ||
      context.profile !== initial.cache_profile ||
      op.target !== "semantic-snapshot-batch:" + initial.id
    )
      throw changed();
    await this.claim(command, token, actor, "semantic-snapshot-batch");
    try {
      const snapshot = await this.cache.snapshots.read(
        actor,
        command.snapshotId,
      );
      await this.editable(actor, snapshot);
      const records = await this.selected(snapshot, command.ideaIds),
        state = await this.ready(snapshot, actor);
      if (
        records.length !== context.count ||
        (await snapshotManifestHash(records, snapshot.fields)) !==
          context.manifest
      )
        throw changed();
      if (state.models.size > 1) throw changed();
      if (records.some((r) => state.valid.some((v) => v.idea_id === r.id)))
        throw new AppError(
          "SEMANTIC_INDEX_CURRENT",
          "Another request already built some selected records. Review only the remaining work; no model call was made.",
          409,
        );
      if (
        (await this.cache.stats(actor)).total +
          records.filter((r) => !state.rows.some((v) => v.idea_id === r.id))
            .length >
        3000
      )
        throw new AppError(
          "SEMANTIC_CAPACITY",
          "Snapshot capacity changed. Discard inactive vectors before another batch.",
          409,
        );
      const result = this.confirmed(
        await this.provider.embed(
          records.map((r) => r.input),
          signal,
        ),
        records.length,
      );
      if (state.models.size && !state.models.has(result.model))
        throw new AppError(
          "SEMANTIC_MODEL_CHANGED",
          "The returned model changed across batches. No vectors from this batch were stored; use a pinned compatible deployment.",
          409,
        );
      const verified = await this.cache.snapshots.read(actor, snapshot.id);
      if (
        verified.manifest_hash !== snapshot.manifest_hash ||
        (await snapshotManifestHash(
          await this.selected(snapshot, command.ideaIds),
          snapshot.fields,
        )) !== context.manifest
      )
        throw changed();
      for (let n = 0; n < records.length; n++)
        await this.cache.put(
          actor,
          snapshot.cache_profile,
          { ...records[n], fields: snapshot.fields },
          result.model,
          result.vectors[n],
          op.id,
          this.config.cacheSeconds,
          { id: snapshot.id, expiresAt: snapshot.expires_at },
        );
      if (
        !(await this.operations.finishRunning(op.id, "done", context.manifest))
      )
        throw cancelled();
      return {
        status: "done",
        snapshotId: snapshot.id,
        indexed: records.map((r) => r.id),
        model: result.model,
      };
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
  async prepareActivation(input: SnapshotChoice, actor: string) {
    const command = snapshotChoiceSchema.parse(input),
      snapshot = await this.cache.snapshots.read(actor, command.snapshotId);
    await this.editable(actor, snapshot);
    const complete = await this.complete(snapshot, actor),
      current = await this.current(snapshot),
      previous = await this.cache.snapshots.reference(actor),
      context = snapshotActivationContext.parse({
        snapshotId: snapshot.id,
        cacheProfile: snapshot.cache_profile,
        manifest: snapshot.manifest_hash,
        profile: snapshot.logical_profile,
        context: await this.context(),
        ...complete,
        previous: previous
          ? {
              snapshotId: previous.snapshot_id,
              operationId: previous.operation_id,
            }
          : null,
      }),
      r = await this.operations.issue(
        actor,
        await digest(JSON.stringify(command)),
        "semantic-snapshot-activate",
        await cacheLock(actor),
        JSON.stringify(context),
      );
    return {
      approvalToken: r.token,
      expiresAt: new Date(r.expires).toISOString(),
      command,
      changes: [
        {
          field: "Atomic search pointer",
          before:
            previous?.snapshot_id ??
            "Selected-record index; no active full snapshot",
          after:
            snapshot.id +
            " · " +
            snapshot.records.length +
            " verified vectors · " +
            (complete.model ?? "empty canonical collection"),
        },
        {
          field: "Current canonical scope",
          before: "",
          after: current.map((r) => r.title + " · " + r.id).join("\n"),
        },
        {
          field: "Activation only",
          before: "Current pointer is preserved until the final guarded switch",
          after:
            "Recheck every selected description and complete canonical membership, vector integrity, model and expiry; atomically activate this full manifest only. No model call, canonical Notion write, score change or automatic merge. Old inactive snapshots remain discardable until expiry.",
        },
      ],
    };
  }
  async activate(input: SnapshotChoice, token: string, actor: string) {
    const command = snapshotChoiceSchema.parse(input),
      op = await this.operations.read(token, actor),
      payload = await digest(JSON.stringify(command));
    if (
      op.action !== "semantic-snapshot-activate" ||
      op.target !== (await cacheLock(actor)) ||
      op.payload_hash !== payload
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "Review activation of this complete snapshot again.",
        409,
      );
    if (op.status === "done")
      return { status: "done", snapshotId: op.result_id };
    const context = snapshotActivationContext.parse(
      JSON.parse(op.expected_revision ?? "null"),
    );
    if (
      context.snapshotId !== command.snapshotId ||
      context.context !== (await this.context()) ||
      context.profile !== (await embeddingProfileHash(this.config))
    )
      throw changed();
    await this.operations.claim(op, payload);
    try {
      const snapshot = await this.cache.snapshots.read(
        actor,
        command.snapshotId,
      );
      await this.editable(actor, snapshot);
      if (
        snapshot.cache_profile !== context.cacheProfile ||
        snapshot.manifest_hash !== context.manifest
      )
        throw changed();
      await this.current(snapshot);
      const complete = await this.complete(snapshot, actor);
      if (
        complete.vectorsHash !== context.vectorsHash ||
        complete.model !== context.model
      )
        throw changed();
      const reference = await this.cache.snapshots.reference(actor),
        previous = reference
          ? {
              snapshotId: reference.snapshot_id,
              operationId: reference.operation_id,
            }
          : null;
      if (JSON.stringify(previous) !== JSON.stringify(context.previous))
        throw new AppError(
          "SEMANTIC_SNAPSHOT_CHANGED",
          "The active index changed after review. Review activation again.",
          409,
        );
      await this.cache.snapshots.activate(
        actor,
        snapshot,
        op.id,
        reference,
        complete.model,
      );
      if (!(await this.operations.finishRunning(op.id, "done", snapshot.id)))
        throw cancelled();
      return { status: "done", snapshotId: snapshot.id };
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
}
