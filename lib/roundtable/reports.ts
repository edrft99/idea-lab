import { z } from "zod";
import { NotionRepository, richText } from "../ideas/notion";
import { Operations, digest, type Operation } from "../ideas/operations";
import { AppError } from "../ideas/errors";
import { uuid } from "../ideas/domain";
import { resultSchema, type RoundtableResult } from "./model";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const savedSnapshotSchema = z
  .object({
    format: z.literal("idea-lab-roundtable-report"),
    version: z.literal(1),
    operation: hash,
    ownerHash: hash,
    approvedAt: z.string().datetime({ offset: true }),
    resultHash: hash,
    result: resultSchema,
    storageMode: z.enum(["automatic", "reviewed"]).optional(),
  })
  .strict();
export type SavedSnapshot = z.infer<typeof savedSnapshotSchema>;
export type SavedReport = {
  id: string;
  url: string | null;
  snapshot: SavedSnapshot;
};
export type AutoSaveResult =
  | { status: "saved"; report: SavedReport }
  | {
      status: "failed" | "uncertain";
      operationId: string | null;
      message: string;
    };
const types = {
  Name: "title",
  "Candidate Idea": "relation",
  Status: "select",
  "Review Type": "select",
  "Proposal Payload": "rich_text",
  "Classification Version": "rich_text",
  "Pair Key": "rich_text",
  "Operation ID": "rich_text",
  "Candidate Revision": "rich_text",
  Reviewer: "rich_text",
  "Reviewed Date": "date",
  Reasoning: "rich_text",
  "Approval Hash": "rich_text",
};
const plain = (p: any) =>
  (p?.rich_text ?? p?.title ?? [])
    .map((v: any) => v.plain_text ?? v.text?.content ?? "")
    .join("");
export class RoundtableReports extends NotionRepository {
  async preflight() {
    await this.schema(this.config.reviews, types);
  }
  private async decode(row: any, actor: string): Promise<SavedReport> {
    try {
      const snapshot = savedSnapshotSchema.parse(
          JSON.parse(plain(row.properties["Proposal Payload"])),
        ),
        p = row.properties;
      if (
        snapshot.ownerHash !== (await digest(actor)) ||
        snapshot.resultHash !==
          (await digest(JSON.stringify(snapshot.result))) ||
        snapshot.result.inputHash !==
          (await digest(JSON.stringify(snapshot.result.input))) ||
        plain(p["Classification Version"]) !== "roundtable-report-v1" ||
        plain(p["Operation ID"]) !== snapshot.operation ||
        plain(p["Pair Key"]) !== "roundtable:" + snapshot.result.runId ||
        plain(p["Candidate Revision"]) !==
          snapshot.result.input.inputRevision ||
        p.Status?.select?.name !== "Approved" ||
        p["Review Type"]?.select?.name !== "evaluation review" ||
        JSON.stringify(
          (p["Candidate Idea"]?.relation ?? []).map((v: any) => v.id),
        ) !== JSON.stringify([snapshot.result.input.ideaId])
      )
        throw new Error("Invalid metadata");
      return {
        id: uuid.parse(row.id),
        url:
          typeof row.url === "string" && /^https:\/\//.test(row.url)
            ? row.url
            : null,
        snapshot,
      };
    } catch {
      throw new AppError(
        "ROUNDTABLE_REPORT_INVALID",
        "A saved roundtable report has inconsistent metadata. Inspect it in Notion.",
        409,
      );
    }
  }
  async listReports(ideaId: string, actor: string) {
    await this.preflight();
    const pages = await this.query(this.config.reviews, {
      and: [
        { property: "Candidate Idea", relation: { contains: ideaId } },
        {
          property: "Classification Version",
          rich_text: { equals: "roundtable-report-v1" },
        },
      ],
    });
    const reports = [];
    for (const row of pages) reports.push(await this.decode(row, actor));
    return reports.sort(
      (a, b) =>
        b.snapshot.approvedAt.localeCompare(a.snapshot.approvedAt) ||
        a.id.localeCompare(b.id),
    );
  }
  async findRun(result: RoundtableResult, actor: string) {
    const matches = (await this.listReports(result.input.ideaId, actor)).filter(
      (report) => report.snapshot.result.runId === result.runId,
    );
    if (matches.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "More than one report references this model run. Inspect the records in Notion.",
        409,
      );
    const found = matches[0] ?? null;
    if (
      found &&
      found.snapshot.resultHash !== (await digest(JSON.stringify(result)))
    )
      throw new AppError(
        "ROUNDTABLE_REPORT_INVALID",
        "The saved report differs from this model result.",
        409,
      );
    return found;
  }
  async findReportOperation(op: Operation, actor: string) {
    const reports = (await this.listReports(op.target!, actor)).filter(
      (report) => report.snapshot.operation === op.id,
    );
    if (reports.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple records reference this save. No write was replayed.",
        409,
      );
    const found = reports[0] ?? null;
    if (found && found.snapshot.resultHash !== op.payload_hash)
      throw new AppError(
        "ROUNDTABLE_REPORT_INVALID",
        "The saved report differs from the approved content.",
        409,
      );
    return found;
  }
  async append(snapshot: SavedSnapshot, actor: string) {
    const schema = await this.schema(this.config.reviews, types);
    const values: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                (snapshot.result.participant === "claude" ? "Claude" : "GPT") +
                " roundtable assessment · op:" +
                snapshot.operation,
            },
          },
        ],
      },
      "Candidate Idea": { relation: [{ id: snapshot.result.input.ideaId }] },
      Status: { select: { name: "Approved" } },
      "Review Type": { select: { name: "evaluation review" } },
      "Proposal Payload": richText(JSON.stringify(snapshot)),
      "Classification Version": richText("roundtable-report-v1"),
      "Pair Key": richText("roundtable:" + snapshot.result.runId),
      "Operation ID": richText(snapshot.operation),
      "Candidate Revision": richText(snapshot.result.input.inputRevision),
      Reviewer: richText(actor),
      "Reviewed Date": { date: { start: snapshot.approvedAt } },
      Reasoning: richText(snapshot.result.assessment.summary),
      "Approval Hash": richText(snapshot.operation),
    };
    if (Object.values(values).some((v: any) => v.rich_text?.length > 100))
      throw new AppError(
        "REPORT_TOO_LARGE",
        "This report is too large for Notion storage.",
        400,
      );
    const body = {
      parent: { type: "data_source_id", data_source_id: this.config.reviews },
      properties: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [schema[key].id, value]),
      ),
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: richText(
            snapshot.storageMode === "automatic"
              ? "Automatically saved roundtable report. Model findings remain unapproved; the idea’s active score is unchanged."
              : "Saved roundtable assessment. Viability scores and evidence are preserved in the snapshot; the idea’s active score is unchanged.",
          ),
        },
        {
          object: "block",
          type: "code",
          code: {
            language: "json",
            ...richText(JSON.stringify(snapshot, null, 2)),
          },
        },
      ],
    };
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength > 400000 ||
      body.children.some((b: any) => b.code?.rich_text?.length > 100)
    )
      throw new AppError(
        "REPORT_TOO_LARGE",
        "This report is too large for Notion storage.",
        400,
      );
    const raw = await this.call("pages", "POST", body);
    try {
      return await this.decode(this.checked(raw, this.config.reviews), actor);
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The report save could not be confirmed. Check save status before trying again.",
        503,
        undefined,
        true,
      );
    }
  }
}
export class RoundtableReportService {
  constructor(
    private repository: RoundtableReports,
    private operations: Operations,
  ) {}
  private async proof(result: RoundtableResult, actor: string) {
    const op = await this.operations.readById(result.runId, actor);
    if (
      op.action !== "roundtable-" + result.participant ||
      op.status !== "done" ||
      op.target !== result.input.ideaId ||
      op.result_id !== (await digest(JSON.stringify(result))) ||
      result.inputHash !== (await digest(JSON.stringify(result.input)))
    )
      throw new AppError(
        "AI_PROVENANCE_INVALID",
        "This report does not match a completed model request for the current owner.",
        409,
      );
  }
  private async current(result: RoundtableResult, automatic = false) {
    const idea = await this.repository.get(result.input.ideaId);
    if (
      !automatic &&
      (idea.canonicalIdeaId || idea.revision !== result.input.inputRevision)
    )
      throw new AppError(
        "STALE_IDEA",
        "This idea changed since the assessment. Saved history can still be viewed, but generate a current assessment before saving a new report.",
        409,
      );
  }
  private async confirmStored(report: SavedReport, actor: string) {
    const op = await this.operations.readById(report.snapshot.operation, actor);
    if (
      !["roundtable-save", "roundtable-autosave"].includes(op.action) ||
      op.target !== report.snapshot.result.input.ideaId ||
      op.payload_hash !== report.snapshot.resultHash ||
      !["running", "uncertain", "done"].includes(op.status) ||
      (op.status === "done" && op.result_id !== report.id)
    )
      throw new AppError(
        "ROUNDTABLE_REPORT_INVALID",
        "This report does not match its storage operation.",
        409,
      );
    if (op.status !== "done")
      await this.operations.finish(op.id, "done", report.id);
  }
  async list(ideaId: string, actor: string) {
    const reports = await this.repository.listReports(ideaId, actor);
    for (const report of reports) {
      await this.proof(report.snapshot.result, actor);
      await this.confirmStored(report, actor);
    }
    return reports;
  }
  async preflight() {
    await this.repository.preflight();
  }
  async findGenerated(ideaId: string, runId: string, actor: string) {
    const matches = (await this.list(ideaId, actor)).filter(
      (report) => report.snapshot.result.runId === runId,
    );
    if (matches.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple reports reference this model run.",
        409,
      );
    return matches[0] ?? null;
  }
  async autoSave(
    input: RoundtableResult,
    actor: string,
  ): Promise<AutoSaveResult> {
    let operationId: string | null = null;
    try {
      const approval = await this.prepare(input, actor, true);
      if (approval.report) {
        await this.confirmStored(approval.report, actor);
        return { status: "saved", report: approval.report };
      }
      operationId = await digest(approval.approvalToken);
      const { report } = await this.commit(
        input,
        approval.approvalToken,
        actor,
        true,
      );
      return { status: "saved", report };
    } catch (error) {
      return {
        status:
          error instanceof AppError &&
          (error.uncertain || error.code === "RECONCILIATION_REQUIRED")
            ? "uncertain"
            : "failed",
        operationId,
        message:
          error instanceof AppError
            ? error.message
            : "The report could not be saved. The model will not be run again.",
      };
    }
  }
  async prepare(input: RoundtableResult, actor: string, automatic = false) {
    const result = resultSchema.parse(input);
    await this.proof(result, actor);
    const existing = await this.repository.findRun(result, actor);
    if (existing) return { report: existing };
    await this.current(result, automatic);
    const receipt = await this.operations.issue(
      actor,
      await digest(JSON.stringify(result)),
      automatic ? "roundtable-autosave" : "roundtable-save",
      result.input.ideaId,
      result.input.inputRevision,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      result,
    };
  }
  async commit(
    input: RoundtableResult,
    token: string,
    actor: string,
    automatic = false,
  ) {
    const result = resultSchema.parse(input),
      hash = await digest(JSON.stringify(result)),
      op = await this.operations.read(token, actor);
    if (
      op.action !== (automatic ? "roundtable-autosave" : "roundtable-save") ||
      op.payload_hash !== hash ||
      op.target !== result.input.ideaId ||
      op.expected_revision !== result.input.inputRevision
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "This report differs from the save you reviewed.",
        409,
      );
    await this.proof(result, actor);
    if (op.status === "done") {
      const report = await this.repository.findRun(result, actor);
      if (!report)
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "The saved report is unavailable in Notion. No write was replayed.",
          409,
        );
      return { report };
    }
    await this.operations.claim(op, hash);
    let attempted = false;
    try {
      const existing = await this.repository.findRun(result, actor);
      if (existing) {
        await this.operations.finish(op.id, "done", existing.id);
        return { report: existing };
      }
      await this.current(result, automatic);
      await this.repository.preflight();
      const snapshot = savedSnapshotSchema.parse({
        format: "idea-lab-roundtable-report",
        version: 1,
        operation: op.id,
        ownerHash: await digest(actor),
        approvedAt: new Date().toISOString(),
        resultHash: hash,
        result,
        storageMode: automatic ? "automatic" : "reviewed",
      });
      attempted = true;
      const report = await this.repository.append(snapshot, actor);
      await this.operations.finish(op.id, "done", report.id);
      return { report };
    } catch (error) {
      const uncertain =
        attempted && (!(error instanceof AppError) || error.uncertain);
      try {
        await this.operations.finish(op.id, uncertain ? "uncertain" : "failed");
      } catch {}
      if (uncertain)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "Notion may have saved this report. Check save status; do not submit a new save.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  async recover(input: RoundtableResult, actor: string) {
    const result = resultSchema.parse(input);
    await this.proof(result, actor);
    const report = await this.repository.findRun(result, actor);
    if (!report) return { status: "uncertain", report: null };
    return this.reconcile(report.snapshot.operation, actor);
  }
  async reconcile(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (
      !["roundtable-save", "roundtable-autosave"].includes(op.action) ||
      !op.target
    )
      throw new AppError(
        "INVALID_OPERATION",
        "This is not a roundtable report save.",
        400,
      );
    if (!["running", "uncertain", "done"].includes(op.status))
      return { status: op.status, report: null };
    const report =
      op.status === "done"
        ? (await this.repository.listReports(op.target, actor)).find(
            (row) => row.id === op.result_id,
          )
        : await this.repository.findReportOperation(op, actor);
    if (report) {
      if (report.snapshot.resultHash !== op.payload_hash)
        throw new AppError(
          "ROUNDTABLE_REPORT_INVALID",
          "The saved report differs from this approval.",
          409,
        );
      await this.proof(report.snapshot.result, actor);
      if (op.status !== "done")
        await this.operations.finish(op.id, "done", report.id);
      return { status: "done", report };
    }
    return { status: op.status, report: null };
  }
}
