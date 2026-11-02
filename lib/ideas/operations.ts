import {
  semanticActions,
  snapshotActions,
} from "../intelligence/semantic-actions";
import { AppError } from "./errors";
import type { OperationalDB } from "./runtime";
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export interface Operation {
  id: string;
  actor_hash: string;
  payload_hash: string;
  action: string;
  target: string | null;
  expected_revision: string | null;
  expires_at: number;
  status: "pending" | "running" | "done" | "uncertain" | "failed" | "cancelled";
  result_id: string | null;
  created_at: number;
}
export class Operations {
  constructor(private db: OperationalDB) {}
  async issue(
    actor: string,
    payloadHash: string,
    action: string,
    target: string | null,
    revision: string | null,
  ) {
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
      id = await digest(token),
      now = Date.now(),
      expires = now + 300000;
    await this.db
      .prepare(
        "INSERT INTO idea_lab_operations (id,actor_hash,payload_hash,action,target,expected_revision,expires_at,status,created_at) VALUES (?,?,?,?,?,?,?,'pending',?)",
      )
      .bind(
        id,
        await digest(actor),
        payloadHash,
        action,
        target,
        revision,
        expires,
        now,
      )
      .run();
    return { token, id, expires };
  }
  async read(token: string, actor: string): Promise<Operation> {
    if (!/^[a-f0-9]{64}$/.test(token))
      throw new AppError("INVALID_APPROVAL", "This approval is invalid.", 400);
    const op = await this.db
      .prepare("SELECT * FROM idea_lab_operations WHERE id=?")
      .bind(await digest(token))
      .first<Operation>();
    if (!op || op.actor_hash !== (await digest(actor)))
      throw new AppError(
        "INVALID_APPROVAL",
        "This approval does not belong to the current user.",
        403,
      );
    return op;
  }
  async recent(actor: string) {
    return (
      await this.db
        .prepare(
          "SELECT o.id,o.action,o.target,o.status,o.result_id,o.created_at,o.expires_at,i.job_id FROM idea_lab_operations o LEFT JOIN idea_lab_import_job_items i ON i.operation_id=o.id OR (o.action='import-recover' AND i.operation_id=o.target) WHERE o.actor_hash=? ORDER BY o.created_at DESC LIMIT 20",
        )
        .bind(await digest(actor))
        .all()
    ).results;
  }
  async countAIAttempts(actor: string, since: number) {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM idea_lab_operations WHERE actor_hash=? AND action IN ('ai-evaluate','ai-extract','roundtable-gpt','semantic-index','semantic-query','semantic-snapshot-batch') AND created_at>=? AND status<>'pending'",
      )
      .bind(await digest(actor), since)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
  async countAttempts(actor: string, action: string, since: number) {
    const row = await this.db
      .prepare(
        "SELECT COUNT(*) AS count FROM idea_lab_operations WHERE actor_hash=? AND action=? AND created_at>=? AND status<>'pending'",
      )
      .bind(await digest(actor), action, since)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }
  async latestResult(
    actor: string,
    action: string,
    target: string,
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        "SELECT result_id FROM idea_lab_operations WHERE actor_hash=? AND action=? AND target=? AND status='done' ORDER BY created_at DESC,rowid DESC LIMIT 1",
      )
      .bind(await digest(actor), action, target)
      .first<{ result_id: string | null }>();
    return row?.result_id ?? null;
  }
  async readById(id: string, actor: string): Promise<Operation> {
    if (!/^[a-f0-9]{64}$/.test(id))
      throw new AppError(
        "INVALID_OPERATION",
        "This operation reference is invalid.",
        400,
      );
    const op = await this.db
      .prepare("SELECT * FROM idea_lab_operations WHERE id=?")
      .bind(id)
      .first<Operation>();
    if (!op || op.actor_hash !== (await digest(actor)))
      throw new AppError(
        "INVALID_OPERATION",
        "This operation does not belong to the current user.",
        403,
      );
    return op;
  }
  async claim(
    op: Operation,
    payloadHash: string,
    additionalTargets: string[] = [],
  ) {
    if (op.payload_hash !== payloadHash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The reviewed changes were edited. Review them again.",
        409,
      );
    if (op.status === "done") return false;
    if (op.status === "uncertain" || op.status === "running")
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "This save is already in progress or needs reconciliation. Check its status.",
        409,
        undefined,
        true,
      );
    if (op.status !== "pending" || op.expires_at < Date.now())
      throw new AppError(
        "APPROVAL_EXPIRED",
        "This approval is no longer available. Review the changes again.",
        409,
      );
    const targets = [
      ...new Set([op.target ?? "create:" + payloadHash, ...additionalTargets]),
    ].sort();
    if (targets.length > 10 || targets.some((t) => !t || t.length > 200))
      throw new AppError(
        "INVALID_LOCK_TARGET",
        "This operation has unsupported coordination targets.",
        400,
      );
    const acquired: string[] = [];
    try {
      for (const target of targets) {
        const inserted = await this.db
          .prepare(
            "INSERT INTO idea_lab_operation_locks (target,operation_id) VALUES (?,?) ON CONFLICT(target) DO NOTHING RETURNING operation_id",
          )
          .bind(target, op.id)
          .first<{ operation_id: string }>();
        if (!inserted)
          throw new AppError(
            "SAVE_BUSY",
            "Another save is processing one of these records. Check its status before reviewing again.",
            409,
          );
        acquired.push(target);
      }
      const claimed = await this.db
        .prepare(
          "UPDATE idea_lab_operations SET status='running' WHERE id=? AND status='pending' AND expires_at>=? RETURNING id",
        )
        .bind(op.id, Date.now())
        .first<{ id: string }>();
      if (!claimed)
        throw new AppError(
          "APPROVAL_USED",
          "This approval was already consumed or expired.",
          409,
        );
      return true;
    } catch (error) {
      for (const target of acquired) {
        try {
          await this.db
            .prepare(
              "DELETE FROM idea_lab_operation_locks WHERE target=? AND operation_id=?",
            )
            .bind(target, op.id)
            .run();
        } catch {}
      }
      throw error;
    }
  }

  async resume(op: Operation, targets: string[] = []) {
    if (op.status !== "uncertain")
      throw new AppError(
        "SAVE_BUSY",
        "Only a confirmed interrupted save can be resumed. Check its status first.",
        409,
      );
    for (const target of [...new Set([op.target!, ...targets])]) {
      const lock = await this.db
        .prepare(
          "SELECT operation_id FROM idea_lab_operation_locks WHERE target=?",
        )
        .bind(target)
        .first<{ operation_id: string }>();
      if (lock?.operation_id !== op.id)
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "This save no longer owns all required record locks.",
          409,
        );
    }
    const claimed = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status='running' WHERE id=? AND status='uncertain' RETURNING id",
      )
      .bind(op.id)
      .first<{ id: string }>();
    if (!claimed)
      throw new AppError(
        "SAVE_BUSY",
        "Another recovery is already processing this save.",
        409,
      );
  }

  async requireAssistantApproval(
    id: string,
    actor: string,
    payloadHash: string,
  ) {
    const granted = await this.db
      .prepare(
        "SELECT id FROM idea_lab_assistant_captures WHERE id=? AND owner_hash=? AND payload_hash=? AND approved_at IS NOT NULL AND expires_at>? AND command_json IS NOT NULL",
      )
      .bind(id, await digest(actor), payloadHash, Date.now())
      .first();
    if (!granted)
      throw new AppError(
        "HUMAN_APPROVAL_REQUIRED",
        "Open the Idea Lab review link and approve this exact capture before saving. A client flag or remembered tool permission cannot approve it.",
        409,
      );
  }
  async pendingAttachments(actor: string, ideaId: string) {
    return (
      await this.db
        .prepare(
          "SELECT id,status,created_at FROM idea_lab_operations WHERE actor_hash=? AND action='attach-file' AND target=? AND status IN ('running','uncertain') ORDER BY created_at DESC LIMIT 10",
        )
        .bind(await digest(actor), ideaId)
        .all<{ id: string; status: string; created_at: number }>()
    ).results;
  }
  async confirmAttachment(id: string, blockId: string) {
    const saved = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status='done',result_id=? WHERE id=? AND action='attach-file' AND status IN ('running','uncertain') RETURNING id",
      )
      .bind(blockId, id)
      .first();
    if (saved) await this.unlock(id);
    return !!saved;
  }
  async finishRunning(
    id: string,
    status: "done" | "failed",
    resultId: string | null = null,
  ) {
    const saved = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status=?,result_id=? WHERE id=? AND status='running' RETURNING id",
      )
      .bind(status, resultId, id)
      .first();
    if (saved) await this.unlock(id);
    return !!saved;
  }
  async cancelSemantic(op: Operation) {
    if (!semanticActions.some((action) => action === op.action))
      throw new AppError(
        "INVALID_OPERATION",
        "Only derived semantic operations can be cancelled here.",
        400,
      );
    const changed = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status='cancelled',result_id=NULL WHERE id=? AND status IN ('pending','running','uncertain') RETURNING id",
      )
      .bind(op.id)
      .first();
    if (changed) await this.unlock(op.id);
    return !!changed;
  }
  async confirmSemanticIndex(id: string, resultId: string) {
    const saved = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status='done',result_id=? WHERE id=? AND action IN ('semantic-index','semantic-snapshot-batch') AND status IN ('running','uncertain','failed') RETURNING id",
      )
      .bind(resultId, id)
      .first();
    if (saved) await this.unlock(id);
    return !!saved;
  }
  async confirmSemanticDerived(
    id: string,
    action: string,
    resultId: string | null,
  ) {
    if (
      ![...snapshotActions, "semantic-clear"].some(
        (allowed) => action === allowed,
      )
    )
      throw new AppError(
        "INVALID_OPERATION",
        "Only a verified derived operation can be reconciled here.",
        400,
      );
    const saved = await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status='done',result_id=? WHERE id=? AND action=? AND status IN ('running','uncertain','failed') RETURNING id",
      )
      .bind(resultId, id, action)
      .first();
    if (saved) await this.unlock(id);
    return !!saved;
  }
  // GPT generation never mutates Notion. Retain an uncertain request status,
  // but do not leave the idea or shared provider budget locked after it ends.
  async finishRoundtableRequest(
    id: string,
    status: "done" | "failed" | "uncertain",
    resultId: string | null = null,
  ) {
    await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status=?,result_id=? WHERE id=? AND action='roundtable-gpt' AND status<>'done'",
      )
      .bind(status, resultId, id)
      .run();
    await this.unlock(id);
  }
  async finish(
    id: string,
    status: Operation["status"],
    resultId: string | null = null,
  ) {
    await this.db
      .prepare(
        "UPDATE idea_lab_operations SET status=?, result_id=? WHERE id=? AND status<>'done'",
      )
      .bind(status, resultId, id)
      .run();
    if (status === "done" || status === "failed") await this.unlock(id);
  }
  private async unlock(id: string) {
    await this.db
      .prepare("DELETE FROM idea_lab_operation_locks WHERE operation_id=?")
      .bind(id)
      .run();
  }
}
