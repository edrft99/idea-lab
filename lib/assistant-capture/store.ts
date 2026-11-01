import { z } from "zod";
import { AppError } from "../ideas/errors";
import { digest, type Operations } from "../ideas/operations";
import type { OperationalDB } from "../ideas/runtime";
import {
  captureId,
  captureClients,
  storedCaptureSchema,
  type StoredCapture,
} from "./model";
const rowSchema = z.object({
  id: captureId,
  owner_hash: captureId,
  request_key: captureId,
  request_hash: captureId,
  payload_hash: captureId,
  client: z.enum(captureClients),
  command_json: z.string().nullable(),
  approved_at: z.number().int().positive().nullable(),
  created_at: z.number().int().positive(),
  expires_at: z.number().int().positive(),
});
export type CaptureRow = z.infer<typeof rowSchema>;
export class AssistantCaptureStore {
  constructor(
    private db: OperationalDB,
    private operations: Operations,
  ) {}
  async purge(actor: string) {
    await this.db
      .prepare(
        "UPDATE idea_lab_assistant_captures SET command_json=NULL,approved_at=NULL WHERE owner_hash=? AND expires_at<=? AND command_json IS NOT NULL",
      )
      .bind(await digest(actor), Date.now())
      .run();
  }
  async byRequest(actor: string, key: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM idea_lab_assistant_captures WHERE owner_hash=? AND request_key=?",
      )
      .bind(await digest(actor), key)
      .first<CaptureRow>();
    return row ? rowSchema.parse(row) : null;
  }
  async read(actor: string, id: string) {
    const row = await this.db
      .prepare(
        "SELECT * FROM idea_lab_assistant_captures WHERE owner_hash=? AND id=?",
      )
      .bind(await digest(actor), captureId.parse(id))
      .first<CaptureRow>();
    if (!row)
      throw new AppError(
        "ASSISTANT_CAPTURE_NOT_FOUND",
        "This capture does not belong to the current owner or is no longer available.",
        404,
      );
    const parsed = rowSchema.parse(row),
      op = await this.operations.readById(parsed.id, actor);
    if (
      parsed.payload_hash !== op.payload_hash ||
      parsed.created_at !== op.created_at ||
      parsed.expires_at !== op.expires_at ||
      parsed.expires_at - parsed.created_at !== 300000
    )
      throw new AppError(
        "ASSISTANT_CAPTURE_INVALID",
        "This draft no longer matches its original receipt. It cannot be approved or saved.",
        409,
      );
    return { row: parsed, op };
  }
  async payload(row: CaptureRow) {
    if (!row.command_json || row.expires_at <= Date.now())
      throw new AppError(
        "ASSISTANT_CAPTURE_EXPIRED",
        "This temporary capture draft expired. Check the prior save status before preparing a fresh request.",
        409,
      );
    try {
      if (new TextEncoder().encode(row.command_json).length > 160000)
        throw new Error("Oversized draft");
      const payload = storedCaptureSchema.parse(JSON.parse(row.command_json));
      if (
        payload.client !== row.client ||
        payload.requestHash !== row.request_hash ||
        (await digest(JSON.stringify(payload.command))) !== row.payload_hash
      )
        throw new Error("Changed draft");
      return payload;
    } catch {
      throw new AppError(
        "ASSISTANT_CAPTURE_INVALID",
        "The staged draft changed or is invalid. Nothing was saved; review a new request.",
        409,
      );
    }
  }
  async insert(actor: string, key: string, payload: StoredCapture, id: string) {
    const op = await this.operations.readById(id, actor),
      encoded = JSON.stringify(storedCaptureSchema.parse(payload));
    if (new TextEncoder().encode(encoded).length > 160000)
      throw new AppError(
        "ASSISTANT_CAPTURE_TOO_LARGE",
        "Shorten this selected idea draft before capture.",
        413,
      );
    const owner = await digest(actor),
      inserted = await this.db
        .prepare(
          "INSERT INTO idea_lab_assistant_captures (id,owner_hash,request_key,request_hash,payload_hash,client,command_json,approved_at,created_at,expires_at) SELECT ?,?,?,?,?,?,?,NULL,?,? WHERE EXISTS(SELECT 1 FROM idea_lab_operations WHERE id=? AND actor_hash=? AND payload_hash=? AND status='pending' AND expires_at>?) AND (SELECT COUNT(*) FROM idea_lab_assistant_captures WHERE owner_hash=? AND command_json IS NOT NULL AND expires_at>?)<20 ON CONFLICT(owner_hash,request_key) DO NOTHING RETURNING id",
        )
        .bind(
          id,
          owner,
          key,
          payload.requestHash,
          op.payload_hash,
          payload.client,
          encoded,
          op.created_at,
          op.expires_at,
          id,
          owner,
          op.payload_hash,
          Date.now(),
          owner,
          Date.now(),
        )
        .first();
    if (!inserted) {
      const prior = await this.byRequest(actor, key);
      if (prior) return prior;
      throw new AppError(
        "ASSISTANT_CAPTURE_LIMIT",
        "Review or reject existing drafts before staging more than 20 active captures.",
        429,
        60,
      );
    }
    return (await this.read(actor, id)).row;
  }
  async approve(actor: string, id: string) {
    const { row, op } = await this.read(actor, id);
    await this.payload(row);
    if (op.status !== "pending")
      throw new AppError(
        "CAPTURE_NOT_PENDING",
        "This capture is already running, completed or unavailable. Check its status.",
        409,
      );
    const saved = await this.db
      .prepare(
        "UPDATE idea_lab_assistant_captures SET approved_at=COALESCE(approved_at,?) WHERE id=? AND owner_hash=? AND payload_hash=? AND command_json IS NOT NULL AND expires_at>? AND EXISTS(SELECT 1 FROM idea_lab_operations WHERE id=? AND actor_hash=? AND payload_hash=? AND status='pending' AND expires_at>?) RETURNING id",
      )
      .bind(
        Date.now(),
        id,
        await digest(actor),
        op.payload_hash,
        Date.now(),
        id,
        await digest(actor),
        op.payload_hash,
        Date.now(),
      )
      .first();
    if (!saved)
      throw new AppError(
        "CAPTURE_APPROVAL_CHANGED",
        "This exact draft is no longer available for approval. Nothing was saved.",
        409,
      );
  }
  async forget(actor: string, id: string) {
    await this.db
      .prepare(
        "UPDATE idea_lab_assistant_captures SET command_json=NULL,approved_at=NULL WHERE id=? AND owner_hash=?",
      )
      .bind(id, await digest(actor))
      .run();
  }
  async reject(actor: string, id: string) {
    const { op } = await this.read(actor, id);
    if (op.status === "cancelled") return;
    const cancelled = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status='cancelled' WHERE id=? AND actor_hash=? AND status='pending' RETURNING id",
      )
      .bind(id, await digest(actor))
      .first();
    if (!cancelled)
      throw new AppError(
        "SAVE_BUSY",
        "The save has already started or completed. Check its canonical status before another action.",
        409,
      );
    await this.forget(actor, id);
  }
}
