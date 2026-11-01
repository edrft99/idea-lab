import { SnapshotStore, unavailableSnapshot } from "./snapshot-store";
import { Buffer } from "node:buffer";
import { z } from "zod";
import { AppError } from "../ideas/errors";
import { digest } from "../ideas/operations";
import type { OperationalDB } from "../ideas/runtime";
import { uuid } from "../ideas/domain";
import { fieldsSchema, unitVector } from "./semantic-model";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const rowSchema = z.object({
  owner_hash: hash,
  profile_hash: hash,
  idea_id: uuid,
  input_hash: hash,
  input_revision: z.string().min(1).max(300),
  fields_json: z.string().max(500),
  model: z.string().min(1).max(200),
  dimensions: z.number().int().min(1).max(4096),
  vector: z.string().min(4).max(22000),
  vector_hash: hash,
  operation_id: hash,
  updated_at: z.number().int().positive(),
  expires_at: z.number().int().positive(),
});
export type VectorRow = z.infer<typeof rowSchema>;
export const cacheLock = async (actor: string) =>
  "semantic-cache:" + (await digest(actor));
export function encodeVector(vector: number[]) {
  const bytes = Buffer.alloc(vector.length * 4);
  vector.forEach((n, i) => bytes.writeFloatLE(n, i * 4));
  return bytes.toString("base64");
}
export async function decodeVector(row: VectorRow) {
  if (
    (await digest(row.vector)) !== row.vector_hash ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(row.vector)
  )
    throw new Error("Invalid vector integrity");
  const bytes = Buffer.from(row.vector, "base64");
  if (bytes.length !== row.dimensions * 4)
    throw new Error("Invalid vector size");
  return unitVector(
    Array.from({ length: row.dimensions }, (_, i) => bytes.readFloatLE(i * 4)),
    row.dimensions,
  );
}
export class SemanticCache {
  readonly snapshots: SnapshotStore;
  constructor(private db: OperationalDB) {
    this.snapshots = new SnapshotStore(db);
  }
  async purgeExpired(actor: string) {
    await this.db
      .prepare(
        "DELETE FROM idea_lab_semantic_vectors WHERE owner_hash=? AND expires_at<=?",
      )
      .bind(await digest(actor), Date.now())
      .run();
    await this.snapshots.purgeExpired(actor);
  }
  async rows(actor: string, profile: string, includeExpired = false) {
    const active = await this.snapshots.active(actor);
    if (!active) return this.rawRows(actor, profile, includeExpired);
    if (active.logical_profile !== profile)
      throw new AppError(
        "SEMANTIC_MODEL_CHANGED",
        "The active snapshot uses a different embedding profile. Build and activate a compatible replacement; no older index was used.",
        409,
      );
    const rows = await this.rawRows(
        actor,
        active.cache_profile,
        includeExpired,
      ),
      byId = new Map(active.records.map((r) => [r.id, r]));
    if (
      rows.length !== active.records.length ||
      (rows.length > 0 && new Set(rows.map((r) => r.model)).size !== 1) ||
      rows.some((r) => {
        const planned = byId.get(r.idea_id);
        return (
          !planned ||
          r.input_hash !== planned.inputHash ||
          r.input_revision !== planned.revision ||
          r.dimensions !== active.descriptor.dimensions ||
          r.expires_at <= Date.now() ||
          r.expires_at > active.expires_at ||
          r.fields_json !== JSON.stringify(active.fields)
        );
      })
    )
      throw unavailableSnapshot();
    return rows;
  }
  async rawRows(actor: string, profile: string, includeExpired = false) {
    const result = (
      await this.db
        .prepare(
          "SELECT * FROM idea_lab_semantic_vectors WHERE owner_hash=? AND profile_hash=? AND (?=1 OR expires_at>?) ORDER BY idea_id LIMIT 1001",
        )
        .bind(await digest(actor), profile, includeExpired ? 1 : 0, Date.now())
        .all<VectorRow>()
    ).results;
    if (result.length > 1000)
      throw new AppError(
        "SEMANTIC_CAPACITY",
        "This semantic profile exceeds the 1,000-vector limit. Clear or reduce the derived index.",
        409,
      );
    return result;
  }
  async byOperation(actor: string, id: string) {
    return (
      await this.db
        .prepare(
          "SELECT * FROM idea_lab_semantic_vectors WHERE owner_hash=? AND operation_id=? ORDER BY idea_id LIMIT 21",
        )
        .bind(await digest(actor), id)
        .all<VectorRow>()
    ).results;
  }
  async checked(row: VectorRow) {
    const parsed = rowSchema.parse(row),
      fields = fieldsSchema.parse(JSON.parse(parsed.fields_json));
    if (
      parsed.expires_at <= parsed.updated_at ||
      parsed.expires_at - parsed.updated_at > 604800000
    )
      throw new Error("Invalid vector retention");
    const vector = await decodeVector(parsed);
    return { ...parsed, fields, values: vector };
  }
  async stats(actor: string) {
    return (
      (await this.db
        .prepare(
          "SELECT COUNT(*) AS total, SUM(CASE WHEN expires_at>? THEN 1 ELSE 0 END) AS usable FROM idea_lab_semantic_vectors WHERE owner_hash=?",
        )
        .bind(Date.now(), await digest(actor))
        .first<{ total: number; usable: number | null }>()) ?? {
        total: 0,
        usable: 0,
      }
    );
  }
  async fingerprint(actor: string) {
    const rows = (
      await this.db
        .prepare(
          "SELECT profile_hash,idea_id,input_hash,input_revision,fields_json,model,dimensions,vector_hash,operation_id,updated_at,expires_at FROM idea_lab_semantic_vectors WHERE owner_hash=? ORDER BY profile_hash,idea_id LIMIT 10001",
        )
        .bind(await digest(actor))
        .all()
    ).results;
    if (rows.length > 10000)
      throw new AppError(
        "SEMANTIC_CAPACITY",
        "This cache exceeds the review limit; inspect it before clearing.",
        409,
      );
    const metadata = await this.snapshots.metadata(actor);
    return {
      count: rows.length,
      snapshotCount: metadata.rows.length,
      active: !!metadata.reference,
      hash: await digest(JSON.stringify([rows, metadata])),
    };
  }
  async put(
    actor: string,
    profile: string,
    record: {
      id: string;
      inputHash: string;
      revision: string;
      fields: z.infer<typeof fieldsSchema>;
    },
    model: string,
    vector: number[],
    operation: string,
    ttl: number,
    snapshot?: { id: string; expiresAt: number },
  ) {
    const owner = await digest(actor),
      encoded = encodeVector(unitVector(vector, vector.length)),
      now = Date.now();
    const written = await this.db
      .prepare(
        `INSERT INTO idea_lab_semantic_vectors
   (owner_hash,profile_hash,idea_id,input_hash,input_revision,fields_json,model,dimensions,vector,vector_hash,operation_id,updated_at,expires_at)
   SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM idea_lab_operations WHERE id=? AND actor_hash=? AND status='running')
   AND EXISTS(SELECT 1 FROM idea_lab_operation_locks WHERE target=? AND operation_id=?)
   AND (? IS NULL OR EXISTS(SELECT 1 FROM idea_lab_semantic_snapshots WHERE id=? AND owner_hash=? AND cache_profile=? AND expires_at>?))
   ON CONFLICT(owner_hash,profile_hash,idea_id) DO UPDATE SET input_hash=excluded.input_hash,input_revision=excluded.input_revision,fields_json=excluded.fields_json,
   model=excluded.model,dimensions=excluded.dimensions,vector=excluded.vector,vector_hash=excluded.vector_hash,operation_id=excluded.operation_id,updated_at=excluded.updated_at,expires_at=excluded.expires_at RETURNING idea_id`,
      )
      .bind(
        owner,
        profile,
        record.id,
        record.inputHash,
        record.revision,
        JSON.stringify(record.fields),
        model,
        vector.length,
        encoded,
        await digest(encoded),
        operation,
        now,
        Math.min(now + ttl * 1000, snapshot?.expiresAt ?? Infinity),
        operation,
        owner,
        await cacheLock(actor),
        operation,
        snapshot?.id ?? null,
        snapshot?.id ?? null,
        owner,
        profile,
        now,
      )
      .first();
    if (!written)
      throw new AppError(
        "SEMANTIC_CANCELLED",
        "This index operation was cancelled or lost its cache lock. No further cache write was made.",
        409,
      );
  }
  async clear(actor: string, operation: string) {
    const owner = await digest(actor),
      guard = SnapshotStore.fenceSQL,
      args = await this.snapshots.fence(actor, operation);
    await this.snapshots.transact([
      this.db
        .prepare(
          "DELETE FROM idea_lab_semantic_active WHERE owner_hash=? AND " +
            guard,
        )
        .bind(owner, ...args),
      this.db
        .prepare(
          "DELETE FROM idea_lab_semantic_snapshots WHERE owner_hash=? AND " +
            guard,
        )
        .bind(owner, ...args),
      this.db
        .prepare(
          "DELETE FROM idea_lab_semantic_vectors WHERE owner_hash=? AND " +
            guard,
        )
        .bind(owner, ...args),
    ]);
  }
}
