import type { OperationalDB, Statement } from "../ideas/runtime";
import { AppError } from "../ideas/errors";
import { digest } from "../ideas/operations";
import {
  createImportJob,
  jobId,
  jobRow,
  jobItemRow,
  importAttemptLimit,
  importLeaseMs,
  importRetentionMs,
  type ImportJobView,
  type ImportItem,
} from "./job-model";

export class ImportJobStore {
  constructor(readonly db: OperationalDB) {}
  private async batch(statements: Statement[]) {
    if (!this.db.batch)
      throw new AppError(
        "IMPORT_STORAGE_UNAVAILABLE",
        "Import jobs require transactional checkpoint storage.",
        503,
      );
    await this.db.batch(statements);
  }
  async create(input: unknown, actor: string): Promise<ImportJobView> {
    const p = createImportJob.parse(input),
      owner = await digest(actor),
      hash = await digest(JSON.stringify(p.items)),
      now = Date.now();
    const prior = await this.db
      .prepare(
        "SELECT * FROM idea_lab_import_jobs WHERE owner_hash=? AND request_key=?",
      )
      .bind(owner, p.requestKey)
      .first();
    if (prior) {
      const r = jobRow.parse(prior);
      if (r.manifest_hash !== hash)
        throw new AppError(
          "IMPORT_REQUEST_CHANGED",
          "This import request was changed. Start a separate job.",
          409,
        );
      return this.view(r.id, actor);
    }
    await this.cleanup();
    const id = crypto.randomUUID();
    await this.batch([
      this.db
        .prepare(
          "INSERT INTO idea_lab_import_jobs (id,owner_hash,request_key,manifest_hash,status,created_at,updated_at,expires_at) SELECT ?,?,?,?,'active',?,?,? WHERE (SELECT COUNT(*) FROM idea_lab_import_jobs j WHERE j.owner_hash=? AND j.expires_at>? AND j.status='active' AND EXISTS(SELECT 1 FROM idea_lab_import_job_items i WHERE i.job_id=j.id AND i.status<>'done'))<20 ON CONFLICT(owner_hash,request_key) DO NOTHING",
        )
        .bind(
          id,
          owner,
          p.requestKey,
          hash,
          now,
          now,
          now + importRetentionMs,
          owner,
          now,
        ),
      ...p.items.map((item) =>
        this.db
          .prepare(
            "INSERT INTO idea_lab_import_job_items (job_id,id,source_key,source_revision,status,attempts,phase,lease_until,not_before) SELECT ?,?,?,?,'waiting',0,'not_started',0,0 WHERE EXISTS(SELECT 1 FROM idea_lab_import_jobs WHERE id=?)",
          )
          .bind(id, item.id, item.sourceKey, item.sourceRevision, id),
      ),
    ]);
    const exists = await this.db
      .prepare("SELECT id FROM idea_lab_import_jobs WHERE id=?")
      .bind(id)
      .first();
    if (!exists) {
      const existing = await this.db
        .prepare(
          "SELECT id FROM idea_lab_import_jobs WHERE owner_hash=? AND request_key=?",
        )
        .bind(owner, p.requestKey)
        .first();
      if (existing) return this.create(p, actor);
    }
    if (!exists)
      throw new AppError(
        "IMPORT_JOB_LIMIT",
        "Finish or cancel an older job before starting another.",
        429,
      );
    return this.view(id, actor);
  }
  async job(id: string, actor: string) {
    const row = await this.db
      .prepare("SELECT * FROM idea_lab_import_jobs WHERE id=? AND owner_hash=?")
      .bind(jobId.parse(id), await digest(actor))
      .first();
    if (!row)
      throw new AppError(
        "IMPORT_JOB_NOT_FOUND",
        "This import job is unavailable.",
        404,
      );
    return jobRow.parse(row);
  }
  async item(id: string, itemId: string, actor: string) {
    await this.job(id, actor);
    const row = await this.db
      .prepare(
        "SELECT * FROM idea_lab_import_job_items WHERE job_id=? AND id=?",
      )
      .bind(id, jobId.parse(itemId))
      .first();
    if (!row)
      throw new AppError(
        "IMPORT_ITEM_NOT_FOUND",
        "This import item is unavailable.",
        404,
      );
    return jobItemRow.parse(row);
  }
  async active(id: string, actor: string) {
    const job = await this.job(id, actor);
    if (job.expires_at <= Date.now())
      throw new AppError(
        "IMPORT_JOB_EXPIRED",
        "This job expired. Its status can still be checked; new writes require a new reviewed job.",
        409,
      );
    if (job.status !== "active")
      throw new AppError(
        "IMPORT_JOB_STOPPED",
        "Resume this import job before approving another write.",
        409,
      );
    return job;
  }
  async view(id: string, actor: string): Promise<ImportJobView> {
    const job = await this.job(id, actor);
    const rows = await this.db
      .prepare(
        "SELECT i.*,o.payload_hash FROM idea_lab_import_job_items i LEFT JOIN idea_lab_operations o ON o.id=i.operation_id WHERE i.job_id=? ORDER BY i.rowid",
      )
      .bind(id)
      .all();
    return {
      id,
      status: job.status,
      createdAt: new Date(job.created_at).toISOString(),
      expiresAt: new Date(job.expires_at).toISOString(),
      expired: job.expires_at <= Date.now(),
      items: rows.results.map((raw) => {
        const i = jobItemRow.parse(raw);
        return {
          id: i.id,
          sourceKey: i.source_key,
          sourceRevision: i.source_revision,
          status: i.status,
          phase: i.phase,
          attempts: i.attempts,
          attemptLimit: importAttemptLimit,
          notBefore:
            i.not_before > Date.now()
              ? new Date(i.not_before).toISOString()
              : null,
          lastCode: i.last_code,
          ideaId: i.idea_id,
          operationId: i.operation_id,
          payloadHash:
            typeof raw.payload_hash === "string" ? raw.payload_hash : null,
          leaseActive: i.lease_until > Date.now(),
          recoverable:
            i.status === "check" &&
            [
              "not_started",
              "idea_rejected",
              "idea_confirmed",
              "source_rejected",
            ].includes(i.phase) &&
            i.lease_until <= Date.now() &&
            i.attempts < importAttemptLimit,
        };
      }),
    };
  }
  async list(actor: string) {
    await this.cleanup();
    const rows = await this.db
      .prepare(
        "SELECT id FROM idea_lab_import_jobs WHERE owner_hash=? ORDER BY created_at DESC LIMIT 20",
      )
      .bind(await digest(actor))
      .all<{ id: string }>();
    return Promise.all(rows.results.map((row) => this.view(row.id, actor)));
  }
  async control(
    id: string,
    actor: string,
    action: "pause" | "cancel" | "resume",
  ) {
    const job = await this.job(id, actor);
    if (action === "resume" && job.expires_at <= Date.now())
      throw new AppError(
        "IMPORT_JOB_EXPIRED",
        "This job expired and cannot accept new writes.",
        409,
      );
    await this.batch([
      this.db
        .prepare(
          "UPDATE idea_lab_operations SET status='failed' WHERE status='pending' AND id IN (SELECT operation_id FROM idea_lab_import_job_items WHERE job_id=? AND status='review')",
        )
        .bind(id),
      this.db
        .prepare(
          "UPDATE idea_lab_import_job_items SET status='waiting',operation_id=NULL,last_code=NULL WHERE job_id=? AND status='review'",
        )
        .bind(id),
      this.db
        .prepare(
          "UPDATE idea_lab_import_jobs SET status=?,updated_at=? WHERE id=?",
        )
        .bind(
          action === "resume"
            ? "active"
            : action === "pause"
              ? "paused"
              : "cancelled",
          Date.now(),
          id,
        ),
    ]);
    return this.view(id, actor);
  }
  async bind(id: string, itemId: string, actor: string, operationId: string) {
    await this.active(id, actor);
    const item = await this.item(id, itemId, actor);
    this.available(item, ["waiting", "review", "failed"]);
    await this.batch([
      this.db
        .prepare(
          "UPDATE idea_lab_operations SET action='import-create' WHERE id=? AND action='create' AND status='pending' AND actor_hash=?",
        )
        .bind(operationId, await digest(actor)),
      this.db
        .prepare(
          "UPDATE idea_lab_import_job_items SET status='review',operation_id=?,phase='not_started',last_code=NULL,idea_id=NULL,idea_revision=NULL,source_id=NULL WHERE job_id=? AND id=? AND status IN ('waiting','review','failed') AND phase IN ('not_started','idea_rejected') AND attempts<? AND lease_until<=? AND EXISTS(SELECT 1 FROM idea_lab_import_jobs WHERE id=job_id AND status='active' AND expires_at>?) AND EXISTS(SELECT 1 FROM idea_lab_operations WHERE id=? AND action='import-create' AND status='pending')",
        )
        .bind(
          operationId,
          id,
          itemId,
          importAttemptLimit,
          Date.now(),
          Date.now(),
          operationId,
        ),
    ]);
    const current = await this.item(id, itemId, actor);
    if (current.operation_id !== operationId)
      throw new AppError(
        "IMPORT_ITEM_CHANGED",
        "This item changed while its review was prepared. Check its status.",
        409,
      );
  }
  available(item: ImportItem, statuses: string[]) {
    if (item.attempts >= importAttemptLimit)
      throw new AppError(
        "IMPORT_ATTEMPT_LIMIT",
        "The three-attempt limit was reached. Inspect the operation before further work.",
        409,
      );
    if (item.not_before > Date.now())
      throw new AppError(
        "IMPORT_RETRY_LATER",
        "Wait for the displayed retry time before reviewing another attempt.",
        429,
        Math.ceil((item.not_before - Date.now()) / 1000),
      );
    if (!statuses.includes(item.status) || item.lease_until > Date.now())
      throw new AppError(
        "IMPORT_ITEM_BUSY",
        "Check this import item's status before another attempt.",
        409,
      );
    if (
      item.status === "failed" &&
      !["not_started", "idea_rejected"].includes(item.phase)
    )
      throw new AppError(
        "IMPORT_CHECK_REQUIRED",
        "Inspect the interrupted save before trying again.",
        409,
      );
  }
  async claim(
    id: string,
    itemId: string,
    actor: string,
    operationId: string,
    kind: "review" | "check",
  ) {
    await this.active(id, actor);
    const item = await this.item(id, itemId, actor);
    this.available(item, [kind]);
    const nonce = crypto.randomUUID() + crypto.randomUUID(),
      hash = await digest(nonce),
      now = Date.now();
    const row = await this.db
      .prepare(
        "UPDATE idea_lab_import_job_items SET status='running',lease_hash=?,lease_until=?,attempts=attempts+1,last_code=NULL WHERE job_id=? AND id=? AND operation_id=? AND status=? AND attempts<? AND lease_until<=? AND not_before<=? AND EXISTS(SELECT 1 FROM idea_lab_import_jobs WHERE id=job_id AND status='active' AND expires_at>?) RETURNING id",
      )
      .bind(
        hash,
        now + importLeaseMs,
        id,
        itemId,
        operationId,
        kind,
        importAttemptLimit,
        now,
        now,
        now,
      )
      .first();
    if (!row)
      throw new AppError(
        "IMPORT_ITEM_BUSY",
        "Another worker claimed or changed this import item.",
        409,
      );
    return { nonce, hash };
  }
  async beforeWrite(
    id: string,
    itemId: string,
    hash: string,
    phase: "idea_dispatched" | "source_dispatched",
  ) {
    const changed = await this.db
      .prepare(
        "UPDATE idea_lab_import_job_items SET phase=? WHERE job_id=? AND id=? AND status='running' AND lease_hash=? AND lease_until>? AND EXISTS(SELECT 1 FROM idea_lab_import_jobs WHERE id=job_id AND status='active' AND expires_at>?) RETURNING id",
      )
      .bind(phase, id, itemId, hash, Date.now(), Date.now())
      .first();
    if (!changed)
      throw new AppError(
        "IMPORT_LEASE_ENDED",
        "The job was stopped or this worker lease ended before the next write. Check its status.",
        409,
      );
  }
  async expireUnclaimed(id: string, itemId: string, operationId: string) {
    const now = Date.now();
    await this.batch([
      this.db
        .prepare(
          "UPDATE idea_lab_operations SET status='failed' WHERE id=? AND action='import-create' AND status='pending' AND EXISTS(SELECT 1 FROM idea_lab_import_job_items WHERE job_id=? AND id=? AND operation_id=? AND status='running' AND phase='not_started' AND lease_until<=?)",
        )
        .bind(operationId, id, itemId, operationId, now),
      this.db
        .prepare(
          "UPDATE idea_lab_import_job_items SET status='failed',phase='idea_rejected',lease_hash=NULL,lease_until=0,last_code='IMPORT_WORKER_STOPPED' WHERE job_id=? AND id=? AND operation_id=? AND status='running' AND phase='not_started' AND lease_until<=? AND EXISTS(SELECT 1 FROM idea_lab_operations WHERE id=? AND status='failed')",
        )
        .bind(id, itemId, operationId, now, operationId),
    ]);
  }
  async isCurrent(id: string, itemId: string, hash: string) {
    return !!(await this.db
      .prepare(
        "SELECT id FROM idea_lab_import_job_items WHERE job_id=? AND id=? AND lease_hash=? AND status='running'",
      )
      .bind(id, itemId, hash)
      .first());
  }
  async receipt(
    id: string,
    itemId: string,
    hash: string,
    phase: "idea_confirmed" | "source_confirmed",
    record: { id: string; revision?: string },
  ) {
    const changed =
      phase === "idea_confirmed"
        ? await this.db
            .prepare(
              "UPDATE idea_lab_import_job_items SET phase=?,idea_id=?,idea_revision=? WHERE job_id=? AND id=? AND lease_hash=? AND status='running' RETURNING id",
            )
            .bind(phase, record.id, record.revision ?? null, id, itemId, hash)
            .first()
        : await this.db
            .prepare(
              "UPDATE idea_lab_import_job_items SET phase=?,source_id=? WHERE job_id=? AND id=? AND lease_hash=? AND status='running' RETURNING id",
            )
            .bind(phase, record.id, id, itemId, hash)
            .first();
    if (!changed)
      throw new AppError(
        "IMPORT_LEASE_ENDED",
        "This worker's checkpoint was fenced. Check the canonical save status.",
        409,
      );
  }
  async rejected(
    id: string,
    itemId: string,
    hash: string,
    step: "idea" | "source",
    error: unknown,
  ) {
    // Only an explicit rejection can make a dispatch safe to retry. Timeouts/5xx/invalid receipts stay ambiguous.
    if (
      !(error instanceof AppError) ||
      error.uncertain ||
      ![
        "NOTION_ACCESS_DENIED",
        "NOTION_CREDENTIAL_REJECTED",
        "NOTION_RATE_LIMITED",
        "NOT_FOUND",
        "NOTION_REQUEST_REJECTED",
      ].includes(error.code)
    )
      return;
    const attempts = await this.db
      .prepare(
        "SELECT attempts FROM idea_lab_import_job_items WHERE job_id=? AND id=?",
      )
      .bind(id, itemId)
      .first<{ attempts: number }>();
    const retryAt =
      error.code === "NOTION_RATE_LIMITED"
        ? Date.now() +
          Math.min(
            3600,
            Math.max(
              error.retryAfter ?? 0,
              20 * 2 ** Math.min(attempts?.attempts ?? 1, 3),
            ),
          ) *
            1000
        : 0;
    await this.db
      .prepare(
        "UPDATE idea_lab_import_job_items SET phase=?,not_before=MAX(not_before,?) WHERE job_id=? AND id=? AND lease_hash=? AND status='running'",
      )
      .bind(
        step === "idea" ? "idea_rejected" : "source_rejected",
        retryAt,
        id,
        itemId,
        hash,
      )
      .run();
  }
  async settle(
    id: string,
    itemId: string,
    hash: string,
    status: "done" | "check" | "failed",
    ideaId: string | null,
    error?: unknown,
  ) {
    const current = await this.db
      .prepare(
        "SELECT attempts FROM idea_lab_import_job_items WHERE job_id=? AND id=?",
      )
      .bind(id, itemId)
      .first<{ attempts: number }>();
    const code =
      error instanceof AppError && /^[A-Z0-9_]{1,64}$/.test(error.code)
        ? error.code
        : error
          ? "UNAVAILABLE"
          : null;
    const wait =
      error instanceof AppError && error.code === "NOTION_RATE_LIMITED"
        ? Math.min(
            3600,
            Math.max(
              error.retryAfter ?? 0,
              20 * 2 ** Math.min(current?.attempts ?? 1, 3),
            ),
          ) * 1000
        : 0;
    await this.db
      .prepare(
        "UPDATE idea_lab_import_job_items SET status=?,idea_id=COALESCE(?,idea_id),lease_hash=NULL,lease_until=0,not_before=MAX(not_before,?),last_code=? WHERE job_id=? AND id=? AND lease_hash=?",
      )
      .bind(status, ideaId, Date.now() + wait, code, id, itemId, hash)
      .run();
  }
  async checked(
    id: string,
    itemId: string,
    change: {
      done?: boolean;
      ideaId?: string;
      ideaRevision?: string;
      sourceId?: string;
    },
  ) {
    await this.db
      .prepare(
        "UPDATE idea_lab_import_job_items SET status=?,idea_id=COALESCE(?,idea_id),idea_revision=COALESCE(idea_revision,?),source_id=COALESCE(?,source_id),phase=CASE WHEN ?=1 THEN 'source_confirmed' WHEN phase='idea_dispatched' AND ? IS NOT NULL THEN 'idea_confirmed' ELSE phase END,lease_hash=NULL,lease_until=0,last_code=? WHERE job_id=? AND id=? AND lease_until<=? AND status IN ('running','check')",
      )
      .bind(
        change.done ? "done" : "check",
        change.ideaId ?? null,
        change.ideaRevision ?? null,
        change.sourceId ?? null,
        change.done ? 1 : 0,
        change.ideaId ?? null,
        change.done ? null : "RECONCILIATION_REQUIRED",
        id,
        itemId,
        Date.now(),
      )
      .run();
  }
  private async cleanup() {
    const cutoff = Date.now();
    // Keep metadata for any save whose outcome or source attachment still needs inspection.
    const eligible =
      "SELECT j.id FROM idea_lab_import_jobs j WHERE j.expires_at<=? AND NOT EXISTS(SELECT 1 FROM idea_lab_import_job_items i LEFT JOIN idea_lab_operations o ON o.id=i.operation_id WHERE i.job_id=j.id AND (i.status IN ('running','check') OR o.status IN ('running','uncertain'))) LIMIT 100";
    await this.batch([
      this.db
        .prepare(
          "DELETE FROM idea_lab_import_job_items WHERE job_id IN (" +
            eligible +
            ")",
        )
        .bind(cutoff),
      this.db
        .prepare(
          "DELETE FROM idea_lab_import_jobs WHERE id IN (" + eligible + ")",
        )
        .bind(cutoff),
    ]);
  }
}
