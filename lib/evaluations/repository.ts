import type { AIResult } from "../intelligence/model";
import { z } from "zod";
import { NotionRepository, richText, decodeEvaluation } from "../ideas/notion";
import { AppError } from "../ideas/errors";
import {
  type EvaluationCommand,
  dimensions,
  dimensionLabels,
  potential,
} from "./model";
const plain = (p: any) =>
  (p?.title ?? p?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
const evaluationTypes: Record<string, string> = {
  Name: "title",
  "Related Idea": "relation",
  "Evaluation Date": "date",
  "Overall Score": "number",
  "Impact Score": "number",
  "Alignment Score": "number",
  "Feasibility Score": "number",
  "Reusability Score": "number",
  "Timing Score": "number",
  Rationale: "rich_text",
  Risks: "rich_text",
  Assumptions: "rich_text",
  "Recommended Next Action": "rich_text",
  "Model Identifier": "rich_text",
  "Rubric Version": "rich_text",
  "Potential Benefits": "rich_text",
  "Estimated Effort": "select",
  Readiness: "select",
  Confidence: "number",
  Authority: "select",
  "Approved By": "rich_text",
  "Approved At": "date",
  "Input Revision": "rich_text",
  "Weight Snapshot": "rich_text",
};
const projectionTypes: Record<string, string> = {
  "Priority Score": "number",
  Impact: "number",
  "Strategic Alignment": "number",
  Feasibility: "number",
  Reusability: "number",
  Timing: "number",
  "Evaluation Confidence": "number",
  "Latest Evaluation": "relation",
  "Last Reviewed": "date",
  "Score Authority": "select",
  "Approved By": "rich_text",
  "Approved At": "date",
  "Record Version": "rich_text",
};
export class EvaluationRepository extends NotionRepository {
  async assessmentReviews(command: EvaluationCommand): Promise<string[]> {
    const { assessmentKey } = await import("./proposal-model");
    const key = await assessmentKey(
      command.ideaId,
      command.expectedRevision,
      command.draft,
    );
    return (
      await this.query(this.config.reviews, {
        and: [
          { property: "Pair Key", rich_text: { equals: key } },
          {
            property: "Classification Version",
            rich_text: { equals: "assessment-proposal-v1" },
          },
        ],
      })
    ).map((row) => row.id);
  }
  async confirmedEvaluation(
    command: EvaluationCommand,
    operation: string,
    actor: string,
    ai?: AIResult,
  ) {
    const pages = await this.query(this.config.evaluations, {
      property: "Name",
      title: { contains: "op:" + operation },
    });
    if (pages.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple evaluations reference this decision.",
        409,
      );
    if (!pages[0]) return null;
    const row = pages[0],
      p = row.properties,
      d = command.draft;
    const texts = {
      Rationale:
        d.rationale +
        "\n\n" +
        dimensions
          .map((k) => dimensionLabels[k] + ": " + d.evidence[k])
          .join("\n\n"),
      Risks: d.risks,
      Assumptions: d.assumptions,
      "Recommended Next Action": d.nextAction,
      "Model Identifier": ai?.resolvedModel ?? "manual",
      "Rubric Version": d.rubricVersion,
      "Potential Benefits": d.benefits,
      "Approved By": actor,
      "Input Revision": command.expectedRevision,
      "Weight Snapshot": JSON.stringify(d.weights),
    };
    const numbers = {
      "Overall Score": potential(d.ratings, d.weights),
      "Impact Score": d.ratings.impact,
      "Alignment Score": d.ratings.alignment,
      "Feasibility Score": d.ratings.feasibility,
      "Reusability Score": d.ratings.reusability,
      "Timing Score": d.ratings.timing,
      Confidence: d.confidence,
    };
    if (
      plain(p.Name) !==
        (ai ? "AI reviewed evaluation · op:" : "Manual evaluation · op:") +
          operation ||
      JSON.stringify(
        (p["Related Idea"]?.relation ?? []).map((r: any) => r.id),
      ) !== JSON.stringify([command.ideaId]) ||
      Object.entries(texts).some(([k, v]) => plain(p[k]) !== v) ||
      Object.entries(numbers).some(([k, v]) => p[k]?.number !== v) ||
      p.Authority?.select?.name !== "manual-approved" ||
      p["Estimated Effort"]?.select?.name !== d.effort ||
      p.Readiness?.select?.name !== d.readiness ||
      !p["Approved At"]?.date?.start ||
      !p["Evaluation Date"]?.date?.start
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Saved evaluation history differs from the approved assessment. It will not be replayed.",
        409,
      );
    return decodeEvaluation(row);
  }

  async preflight() {
    await this.schema(this.config.evaluations, evaluationTypes);
    await this.schema(this.config.ideas, projectionTypes);
  }
  async findEvaluationOperation(operation: string, ideaId: string) {
    const pages = await this.query(this.config.evaluations, {
      property: "Name",
      title: { contains: "op:" + operation },
    });
    if (pages.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple evaluation records reference this save.",
        409,
      );
    if (!pages[0]) return null;
    const related = pages[0].properties["Related Idea"]?.relation ?? [];
    if (related.length !== 1 || related[0].id !== ideaId)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The saved evaluation references a different idea.",
        409,
      );
    return decodeEvaluation(pages[0]);
  }
  async appendEvaluation(
    command: EvaluationCommand,
    operation: string,
    actor: string,
    ai?: AIResult,
  ) {
    const existing = await this.findEvaluationOperation(
      operation,
      command.ideaId,
    );
    if (existing) return existing;
    const schema = await this.schema(this.config.evaluations, evaluationTypes),
      d = command.draft,
      now = new Date().toISOString();
    const texts: Record<string, string> = {
      Rationale:
        d.rationale +
        "\n\n" +
        dimensions
          .map((k) => dimensionLabels[k] + ": " + d.evidence[k])
          .join("\n\n"),
      Risks: d.risks,
      Assumptions: d.assumptions,
      "Recommended Next Action": d.nextAction,
      "Model Identifier": ai?.resolvedModel ?? "manual",
      "Rubric Version": d.rubricVersion,
      "Potential Benefits": d.benefits,
      "Approved By": actor,
      "Input Revision": command.expectedRevision,
      "Weight Snapshot": JSON.stringify(d.weights),
    };
    const values: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                (ai
                  ? "AI reviewed evaluation · op:"
                  : "Manual evaluation · op:") + operation,
            },
          },
        ],
      },
      "Related Idea": { relation: [{ id: command.ideaId }] },
      "Evaluation Date": { date: { start: now } },
      "Overall Score": { number: potential(d.ratings, d.weights) },
      "Impact Score": { number: d.ratings.impact },
      "Alignment Score": { number: d.ratings.alignment },
      "Feasibility Score": { number: d.ratings.feasibility },
      "Reusability Score": { number: d.ratings.reusability },
      "Timing Score": { number: d.ratings.timing },
      "Estimated Effort": { select: { name: d.effort } },
      Readiness: { select: { name: d.readiness } },
      Confidence: { number: d.confidence },
      Authority: { select: { name: "manual-approved" } },
      "Approved At": { date: { start: now } },
    };
    for (const [key, text] of Object.entries(texts))
      values[key] = richText(text);
    const snapshot = {
      format: "idea-lab-evaluation-history",
      version: 1,
      operation,
      actor,
      inputRevision: command.expectedRevision,
      origin: ai ? "ai" : "manual",
      modelIdentifier: ai?.resolvedModel ?? "manual",
      promptVersion: ai?.promptVersion ?? null,
      ai: ai ?? null,
      draft: d,
      applyToIdea: command.applyToIdea,
      replaceManualScore: command.replaceManualScore,
      overrideReason: command.overrideReason,
    };
    const children = [
      {
        object: "block",
        type: "paragraph",
        paragraph: richText(
          "Immutable evaluation snapshot. Potential is separate from effort and readiness.",
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
    ];
    const raw = await this.call("pages", "POST", {
      parent: {
        type: "data_source_id",
        data_source_id: this.config.evaluations,
      },
      properties: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [schema[key].id, value]),
      ),
      children,
    });
    try {
      return decodeEvaluation(this.checked(raw, this.config.evaluations));
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The evaluation save could not be verified. Check its status before retrying.",
        503,
        undefined,
        true,
      );
    }
  }
  async projectEvaluation(
    command: EvaluationCommand,
    evaluationId: string,
    operation: string,
    actor: string,
  ) {
    const before = await this.get(command.ideaId);
    if (before.revision !== command.expectedRevision)
      throw new AppError(
        "STALE_IDEA",
        "The idea changed after evaluation approval. The history remains saved; the active score was not changed.",
        409,
      );
    const schema = await this.schema(this.config.ideas, projectionTypes),
      page = await this.page(command.ideaId);
    if (
      plain(page.properties["Record Version"]) + "@" + page.last_edited_time !==
      command.expectedRevision
    )
      throw new AppError(
        "STALE_IDEA",
        "The idea changed before score projection.",
        409,
      );
    const d = command.draft,
      now = new Date().toISOString(),
      values: Record<string, unknown> = {
        "Priority Score": { number: potential(d.ratings, d.weights) },
        Impact: { number: d.ratings.impact },
        "Strategic Alignment": { number: d.ratings.alignment },
        Feasibility: { number: d.ratings.feasibility },
        Reusability: { number: d.ratings.reusability },
        Timing: { number: d.ratings.timing },
        "Evaluation Confidence": { number: d.confidence },
        "Latest Evaluation": { relation: [{ id: evaluationId }] },
        "Last Reviewed": { date: { start: now } },
        "Score Authority": { select: { name: "manual-approved" } },
        "Approved By": richText(actor),
        "Approved At": { date: { start: now } },
        "Record Version": richText(
          (plain(page.properties["Record Version"]).split(";")[0] ||
            "legacy:" + command.ideaId) +
            ";revision:" +
            operation,
        ),
      };
    await this.call("pages/" + command.ideaId, "PATCH", {
      properties: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [schema[k].id, v]),
      ),
    });
    return this.get(command.ideaId);
  }
}
