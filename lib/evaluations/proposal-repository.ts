import { AppError } from "../ideas/errors";
import { richText } from "../ideas/notion";
import { digest } from "../ideas/operations";
import { uuid } from "../ideas/domain";
import { reviewTypes } from "../proposals/repository";
import { EvaluationRepository } from "./repository";
import {
  assessmentKey,
  assessmentSnapshotSchema,
  assessmentIntentSchema,
  assessmentResolutionSchema,
  type AssessmentSnapshot,
  type AssessmentIntent,
  type AssessmentProposal,
} from "./proposal-model";
const plain = (p: any) =>
  (p?.rich_text ?? p?.title ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
export class AssessmentRepository extends EvaluationRepository {
  async reviewPreflight() {
    await this.schema(this.config.reviews, reviewTypes);
  }
  private async checkedSnapshot(raw: unknown) {
    const j = assessmentSnapshotSchema.parse(raw);
    if (
      j.commandHash !== (await digest(JSON.stringify(j.command))) ||
      j.key !==
        (await assessmentKey(
          j.command.ideaId,
          j.command.inputRevision,
          j.command.draft,
        ))
    )
      throw new Error("Invalid proposal identity");
    return j;
  }
  private async decode(row: any): Promise<AssessmentProposal> {
    try {
      const p = row.properties,
        j = await this.checkedSnapshot(
          JSON.parse(plain(p["Proposal Payload"])),
        ),
        status = p.Status?.select?.name;
      if (
        plain(p["Classification Version"]) !== "assessment-proposal-v1" ||
        p["Review Type"]?.select?.name !== "evaluation review" ||
        !["Pending", "Approved", "Rejected"].includes(status) ||
        plain(p["Operation ID"]) !== j.operation ||
        plain(p["Pair Key"]) !== j.key ||
        plain(p["Candidate Revision"]) !== j.command.inputRevision ||
        JSON.stringify(
          (p["Candidate Idea"]?.relation ?? []).map((v: any) => v.id),
        ) !== JSON.stringify([j.command.ideaId]) ||
        (p["Potential Matching Idea"]?.relation ?? []).length
      )
        throw new Error("Invalid metadata");
      const decision =
        status === "Pending"
          ? null
          : assessmentResolutionSchema.parse(
              JSON.parse(plain(p["Reviewer Decision"])),
            );
      if (
        (status === "Pending" && plain(p["Reviewer Decision"])) ||
        (decision &&
          (status === "Approved") !== (decision.decision === "Approve"))
      )
        throw new Error("Invalid resolution");
      return {
        id: row.id,
        url:
          typeof row.url === "string" && /^https?:\/\//.test(row.url)
            ? row.url
            : null,
        status,
        snapshot: j,
        decision,
        revision: await digest(
          JSON.stringify([
            row.id,
            row.last_edited_time,
            j,
            status,
            plain(p["Reviewer Decision"]),
            plain(p.Name),
            plain(p.Reasoning),
            plain(p.Reviewer),
            p["Reviewed Date"]?.date?.start ?? null,
            plain(p["Approval Hash"]),
          ]),
        ),
      };
    } catch {
      throw new AppError(
        "ASSESSMENT_INVALID",
        "This saved assessment has inconsistent metadata. Inspect it in Notion before editing.",
        409,
      );
    }
  }
  async proposal(id: string) {
    await this.reviewPreflight();
    const row = await this.page(id, this.config.reviews);
    if (row.in_trash)
      throw new AppError(
        "NOT_FOUND",
        "This assessment proposal is unavailable.",
        404,
      );
    return this.decode(row);
  }
  async history(key: string, hint: string | null) {
    await this.reviewPreflight();
    const rows = await this.query(this.config.reviews, {
        property: "Pair Key",
        rich_text: { equals: key },
      }),
      result: AssessmentProposal[] = [];
    for (const row of rows)
      if (
        plain(row.properties["Classification Version"]) ===
        "assessment-proposal-v1"
      )
        result.push(await this.decode(row));
    if (hint && !result.some((r) => r.id === hint)) {
      const row = await this.proposal(uuid.parse(hint));
      if (row.snapshot.key !== key)
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "The assessment locator differs from its reviewed content.",
          409,
        );
      result.push(row);
    }
    return result;
  }
  body(j: AssessmentSnapshot | AssessmentIntent) {
    const stored = j.format === "idea-lab-assessment-proposal",
      proposal = stored ? j : j.proposal,
      c = proposal.command;
    const values = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                (stored
                  ? "Assessment proposal · "
                  : "Assessment decision intent · ") +
                proposal.input.title.slice(0, 120),
            },
          },
        ],
      },
      "Review Type": { select: { name: "evaluation review" } },
      "Candidate Idea": { relation: [{ id: c.ideaId }] },
      "Potential Matching Idea": { relation: [] },
      Reasoning: richText(stored ? c.note : j.command.reason),
      Status: {
        select: {
          name: stored
            ? "Pending"
            : j.command.decision === "Approve"
              ? "Approved"
              : "Rejected",
        },
      },
      "Reviewer Decision": richText(""),
      "Reviewed Date": stored
        ? { date: null }
        : { date: { start: j.createdAt } },
      Reviewer: richText(j.actor),
      "Candidate Revision": richText(c.inputRevision),
      "Match Revision": richText(""),
      "Pair Key": richText(
        stored ? proposal.key : "assessment-intent:" + j.operation,
      ),
      "Proposal Payload": richText(JSON.stringify(j)),
      "Embedding Version": richText("not-used"),
      "Classification Version": richText(
        stored ? "assessment-proposal-v1" : "assessment-intent-v1",
      ),
      "Approval Hash": richText(j.operation),
      "Operation ID": richText(j.operation),
      "Similarity Score": { number: null },
      "AI Recommendation": { select: null },
    };
    const body = {
      parent: { type: "data_source_id", data_source_id: this.config.reviews },
      properties: values,
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: richText(
            stored
              ? "Pending assessment only. No evaluation history or active score is created. A separate reviewed decision is required."
              : "Decision intent only. This does not prove history or score persistence; check the original operation.",
          ),
        },
        {
          object: "block",
          type: "code",
          code: { language: "json", ...richText(JSON.stringify(j, null, 2)) },
        },
      ],
    };
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength > 400000 ||
      Object.values(values).some((v: any) => v.rich_text?.length > 100) ||
      body.children.some((b: any) => b.code?.rich_text?.length > 100)
    )
      throw new AppError(
        "ASSESSMENT_TOO_LARGE",
        "Shorten this assessment before preserving it.",
        400,
      );
    return body;
  }
  private async append(j: AssessmentSnapshot | AssessmentIntent) {
    await this.reviewPreflight();
    const schema = await this.schema(this.config.reviews, reviewTypes),
      body = this.body(j);
    const raw = await this.call("pages", "POST", {
      ...body,
      properties: Object.fromEntries(
        Object.entries(body.properties).map(([k, v]) => [schema[k].id, v]),
      ),
    });
    try {
      const row = this.checked(raw, this.config.reviews);
      if (
        plain(row.properties["Proposal Payload"]) !== JSON.stringify(j) ||
        plain(row.properties["Operation ID"]) !== j.operation
      )
        throw new Error("Invalid response");
      return row;
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The assessment journal save could not be confirmed. Check status before another save.",
        503,
        undefined,
        true,
      );
    }
  }
  async appendProposal(j: AssessmentSnapshot) {
    return this.decode(await this.append(j));
  }
  async appendIntent(j: AssessmentIntent) {
    const row = await this.append(j);
    return { id: row.id, snapshot: j };
  }
  async findStored(operation: string) {
    const rows = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple assessments reference this save.",
        409,
      );
    return rows[0] ? this.decode(rows[0]) : null;
  }
  async findIntent(operation: string) {
    const rows = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple assessment intents reference this save.",
        409,
      );
    if (!rows[0]) return null;
    try {
      const row = rows[0],
        j = assessmentIntentSchema.parse(
          JSON.parse(plain(row.properties["Proposal Payload"])),
        );
      await this.checkedSnapshot(j.proposal);
      if (
        j.operation !== operation ||
        plain(row.properties["Classification Version"]) !==
          "assessment-intent-v1" ||
        row.properties.Status?.select?.name !==
          (j.command.decision === "Approve" ? "Approved" : "Rejected")
      )
        throw new Error("Invalid intent");
      return { id: row.id, snapshot: j };
    } catch {
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The assessment decision intent could not be verified.",
        409,
      );
    }
  }
  async close(
    intent: { id: string; snapshot: AssessmentIntent },
    evaluationId: string | null,
  ) {
    const j = intent.snapshot,
      row = await this.proposal(j.command.proposalId);
    if (
      row.decision?.decision === j.command.decision &&
      row.decision?.reason === j.command.reason &&
      row.decision?.operation === j.operation &&
      row.decision.intentId === intent.id &&
      row.decision.evaluationId === evaluationId
    )
      return;
    if (row.status !== "Pending" || row.revision !== j.command.proposalRevision)
      throw new AppError(
        "STALE_PROPOSAL",
        "The original assessment changed. Preserve completed history and inspect its save.",
        409,
      );
    const schema = await this.schema(this.config.reviews, reviewTypes),
      decision = assessmentResolutionSchema.parse({
        decision: j.command.decision,
        reason: j.command.reason,
        operation: j.operation,
        intentId: intent.id,
        evaluationId,
      });
    const values = {
      Status: { select: { name: evaluationId ? "Approved" : "Rejected" } },
      "Reviewer Decision": richText(JSON.stringify(decision)),
      Reviewer: richText(j.actor),
      "Reviewed Date": { date: { start: new Date().toISOString() } },
      "Approval Hash": richText(j.operation),
    };
    await this.call("pages/" + row.id, "PATCH", {
      properties: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [schema[k].id, v]),
      ),
    });
    const saved = await this.proposal(row.id);
    if (
      saved.decision?.decision !== j.command.decision ||
      saved.decision?.reason !== j.command.reason ||
      saved.decision?.operation !== j.operation ||
      saved.decision.intentId !== intent.id ||
      saved.decision.evaluationId !== evaluationId
    )
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The assessment decision resolution was not confirmed.",
        503,
        undefined,
        true,
      );
  }
}
