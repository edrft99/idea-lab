import { z } from "zod";
import type { OperationalDB, Statement } from "../ideas/runtime";
import { AppError } from "../ideas/errors";
import { digest } from "../ideas/operations";
import { fieldsSchema } from "./semantic-model";
import {
  snapshotHash,
  snapshotRecordsSchema,
  snapshotDescriptorSchema,
  snapshotManifestHash,
  snapshotStorageProfile,
} from "./snapshot-model";
const rowSchema = z.object({
  id: snapshotHash,
  owner_hash: snapshotHash,
  logical_profile: snapshotHash,
  cache_profile: snapshotHash,
  fields_json: z.string().max(500),
  manifest_json: z.string().max(1000000),
  manifest_hash: snapshotHash,
  descriptor_json: z.string().max(2000),
  context_hash: snapshotHash,
  created_at: z.number().int().positive(),
  expires_at: z.number().int().positive(),
});
export type SnapshotRow = z.infer<typeof rowSchema>;
export type Snapshot = Awaited<ReturnType<SnapshotStore["checked"]>>;
export type ActiveSnapshot = {
  owner_hash: string;
  snapshot_id: string;
  operation_id: string;
  activated_at: number;
};
const unavailable = () =>
  new AppError(
    "SEMANTIC_SNAPSHOT_UNAVAILABLE",
    "The active snapshot is expired, incomplete or invalid. Build and activate a complete replacement or explicitly clear the cache; search did not fall back to an older index.",
    409,
  );
export class SnapshotStore {
  constructor(private db: OperationalDB) {}
  async checked(raw: SnapshotRow) {
    try {
      const row = rowSchema.parse(raw),
        fields = fieldsSchema.parse(JSON.parse(row.fields_json)),
        records = snapshotRecordsSchema.parse(JSON.parse(row.manifest_json)),
        descriptor = snapshotDescriptorSchema.parse(
          JSON.parse(row.descriptor_json),
        );
      if (
        row.expires_at <= row.created_at ||
        row.expires_at - row.created_at > 604800000 ||
        (await snapshotManifestHash(records, fields)) !== row.manifest_hash ||
        (await snapshotStorageProfile(row.id, row.logical_profile)) !==
          row.cache_profile ||
        (await digest(
          JSON.stringify([
            descriptor.endpoint,
            descriptor.deployment,
            descriptor.dimensions,
            descriptor.versionLabel,
            descriptor.inputVersion,
            "f32le-v1",
          ]),
        )) !== row.logical_profile
      )
        throw new Error("Invalid manifest");
      return { ...row, fields, records, descriptor };
    } catch {
      throw unavailable();
    }
  }
  async read(actor: string, id: string, allowExpired = false) {
    const row = await this.db
      .prepare(
        "SELECT * FROM idea_lab_semantic_snapshots WHERE owner_hash=? AND id=?",
      )
      .bind(await digest(actor), snapshotHash.parse(id))
      .first<SnapshotRow>();
    if (!row)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_NOT_FOUND",
        "This snapshot does not belong to the current owner or is no longer retained.",
        404,
      );
    const snapshot = await this.checked(row);
    if (!allowExpired && snapshot.expires_at <= Date.now()) throw unavailable();
    return snapshot;
  }
  async list(actor: string) {
    const rows = (
      await this.db
        .prepare(
          "SELECT * FROM idea_lab_semantic_snapshots WHERE owner_hash=? AND expires_at>? ORDER BY created_at,id LIMIT 4",
        )
        .bind(await digest(actor), Date.now())
        .all<SnapshotRow>()
    ).results;
    if (rows.length > 3)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_CAPACITY",
        "Too many retained snapshot manifests. Review and discard inactive snapshots.",
        409,
      );
    return Promise.all(rows.map((row) => this.checked(row)));
  }
  async reference(actor: string) {
    const ref = await this.db
      .prepare("SELECT * FROM idea_lab_semantic_active WHERE owner_hash=?")
      .bind(await digest(actor))
      .first<ActiveSnapshot>();
    if (
      ref &&
      (!snapshotHash.safeParse(ref.snapshot_id).success ||
        !snapshotHash.safeParse(ref.operation_id).success)
    )
      throw unavailable();
    return ref;
  }
  async active(actor: string) {
    const ref = await this.reference(actor);
    if (!ref) return null;
    try {
      return await this.read(actor, ref.snapshot_id);
    } catch {
      throw unavailable();
    }
  }
  async metadata(actor: string) {
    const owner = await digest(actor),
      rows = (
        await this.db
          .prepare(
            "SELECT * FROM idea_lab_semantic_snapshots WHERE owner_hash=? ORDER BY id LIMIT 4",
          )
          .bind(owner)
          .all<SnapshotRow>()
      ).results;
    if (rows.length > 3)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_CAPACITY",
        "Inspect retained snapshot manifests before further cache changes.",
        409,
      );
    return { rows, reference: await this.reference(actor) };
  }
  async purgeExpired(actor: string) {
    await this.db
      .prepare(
        "DELETE FROM idea_lab_semantic_snapshots WHERE owner_hash=? AND expires_at<=?",
      )
      .bind(await digest(actor), Date.now())
      .run();
  }
  async fence(actor: string, operation: string) {
    return [
      operation,
      await digest(actor),
      "semantic-cache:" + (await digest(actor)),
      operation,
    ] as const;
  }
  static fenceSQL =
    "EXISTS(SELECT 1 FROM idea_lab_operations WHERE id=? AND actor_hash=? AND status='running') AND EXISTS(SELECT 1 FROM idea_lab_operation_locks WHERE target=? AND operation_id=?)";
  async create(actor: string, row: SnapshotRow, operation: string) {
    if (row.owner_hash !== (await digest(actor)) || row.id !== operation)
      throw unavailable();
    await this.checked(row);
    const saved = await this.db
      .prepare(
        "INSERT INTO idea_lab_semantic_snapshots (id,owner_hash,logical_profile,cache_profile,fields_json,manifest_json,manifest_hash,descriptor_json,context_hash,created_at,expires_at) SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE " +
          SnapshotStore.fenceSQL +
          " AND (SELECT COUNT(*) FROM idea_lab_semantic_snapshots WHERE owner_hash=?)<3 RETURNING id",
      )
      .bind(
        row.id,
        row.owner_hash,
        row.logical_profile,
        row.cache_profile,
        row.fields_json,
        row.manifest_json,
        row.manifest_hash,
        row.descriptor_json,
        row.context_hash,
        row.created_at,
        row.expires_at,
        ...(await this.fence(actor, operation)),
        row.owner_hash,
      )
      .first();
    if (!saved)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_NOT_CREATED",
        "The plan was cancelled or snapshot capacity changed. Review the retained snapshots before planning again.",
        409,
      );
  }
  async activate(
    actor: string,
    snapshot: Snapshot,
    operation: string,
    previous: ActiveSnapshot | null,
    model: string | null,
  ) {
    const owner = await digest(actor),
      now = Date.now();
    const saved = await this.db
      .prepare(
        "INSERT INTO idea_lab_semantic_active (owner_hash,snapshot_id,operation_id,activated_at) SELECT ?,?,?,? WHERE " +
          SnapshotStore.fenceSQL +
          " AND EXISTS(SELECT 1 FROM idea_lab_semantic_snapshots WHERE id=? AND owner_hash=? AND manifest_hash=? AND expires_at>?)" +
          " AND ((? IS NULL AND NOT EXISTS(SELECT 1 FROM idea_lab_semantic_active WHERE owner_hash=?)) OR EXISTS(SELECT 1 FROM idea_lab_semantic_active WHERE owner_hash=? AND snapshot_id=? AND operation_id=?))" +
          " AND (SELECT COUNT(*) FROM idea_lab_semantic_vectors WHERE owner_hash=? AND profile_hash=?)=?" +
          " AND NOT EXISTS(SELECT 1 FROM idea_lab_semantic_vectors WHERE owner_hash=? AND profile_hash=? AND (expires_at<=? OR dimensions<>? OR model<>?))" +
          " ON CONFLICT(owner_hash) DO UPDATE SET snapshot_id=excluded.snapshot_id,operation_id=excluded.operation_id,activated_at=excluded.activated_at RETURNING snapshot_id",
      )
      .bind(
        owner,
        snapshot.id,
        operation,
        now,
        ...(await this.fence(actor, operation)),
        snapshot.id,
        owner,
        snapshot.manifest_hash,
        now,
        previous?.snapshot_id ?? null,
        owner,
        owner,
        previous?.snapshot_id ?? null,
        previous?.operation_id ?? null,
        owner,
        snapshot.cache_profile,
        snapshot.records.length,
        owner,
        snapshot.cache_profile,
        now,
        snapshot.descriptor.dimensions,
        model,
      )
      .first();
    if (!saved)
      throw new AppError(
        "SEMANTIC_SNAPSHOT_NOT_ACTIVATED",
        "The snapshot, previous active pointer or operation changed. No partial snapshot was activated; check status and review again.",
        409,
      );
  }
  async fingerprint(actor: string, id: string, cacheProfile: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM idea_lab_semantic_snapshots WHERE owner_hash=? AND id=?",
      )
      .bind(await digest(actor), id)
      .first();
    const vectors = (
      await this.db
        .prepare(
          "SELECT idea_id,input_hash,input_revision,fields_json,model,dimensions,vector_hash,operation_id,updated_at,expires_at FROM idea_lab_semantic_vectors WHERE owner_hash=? AND profile_hash=? ORDER BY idea_id LIMIT 1001",
        )
        .bind(await digest(actor), cacheProfile)
        .all()
    ).results;
    if (vectors.length > 1000) throw unavailable();
    return {
      row,
      count: vectors.length,
      hash: await digest(JSON.stringify([row, vectors])),
    };
  }
  async transact(statements: Statement[]) {
    if (!this.db.batch)
      throw new AppError(
        "TRANSACTION_COORDINATOR_REQUIRED",
        "This derived cache change needs the protected transactional database binding.",
        503,
      );
    await this.db.batch(statements);
  }
  async discard(actor: string, snapshot: Snapshot, operation: string) {
    const owner = await digest(actor),
      guard =
        SnapshotStore.fenceSQL +
        " AND NOT EXISTS(SELECT 1 FROM idea_lab_semantic_active WHERE owner_hash=? AND snapshot_id=?)",
      args = [...(await this.fence(actor, operation)), owner, snapshot.id];
    await this.transact([
      this.db
        .prepare(
          "DELETE FROM idea_lab_semantic_vectors WHERE owner_hash=? AND profile_hash=? AND " +
            guard,
        )
        .bind(owner, snapshot.cache_profile, ...args),
      this.db
        .prepare(
          "DELETE FROM idea_lab_semantic_snapshots WHERE owner_hash=? AND id=? AND " +
            guard,
        )
        .bind(owner, snapshot.id, ...args),
    ]);
  }
}
export { unavailable as unavailableSnapshot };
