import { z } from "zod";
import { efforts, readinessOptions, uuid, type Idea } from "../ideas/domain";
export const dimensions = [
  "impact",
  "alignment",
  "feasibility",
  "reusability",
  "timing",
] as const;
export type Dimension = (typeof dimensions)[number];
export const dimensionLabels: Record<Dimension, string> = {
  impact: "Potential impact",
  alignment: "Strategic alignment",
  feasibility: "Feasibility",
  reusability: "Reusability",
  timing: "Timing",
};
const number = z.number().finite().min(0).max(100);
export const weightSchema = z
  .object({
    impact: number,
    alignment: number,
    feasibility: number,
    reusability: number,
    timing: number,
  })
  .strict()
  .refine(
    (v) =>
      Math.abs(Object.values(v).reduce((a, b) => a + b, 0) - 100) < 0.000001,
    "Weights must total 100%.",
  );
const rating = z.number().int().min(1).max(5);
export const ratingSchema = z
  .object({
    impact: rating,
    alignment: rating,
    feasibility: rating,
    reusability: rating,
    timing: rating,
  })
  .strict();
const evidence = z.string().trim().min(1).max(1200);
export const evidenceSchema = z
  .object({
    impact: evidence,
    alignment: evidence,
    feasibility: evidence,
    reusability: evidence,
    timing: evidence,
  })
  .strict();
export const evaluationDraftSchema = z
  .object({
    rubricVersion: z.string().trim().min(1).max(100),
    weights: weightSchema,
    ratings: ratingSchema,
    evidence: evidenceSchema,
    rationale: z.string().trim().min(1).max(2000),
    benefits: z.string().trim().min(1).max(2000),
    risks: z.string().trim().min(1).max(2000),
    assumptions: z.string().trim().min(1).max(2000),
    effort: z.enum(efforts),
    readiness: z.enum(readinessOptions),
    confidence: z.number().finite().min(0).max(1),
    nextAction: z.string().trim().min(1).max(2000),
  })
  .strict();
export type EvaluationDraft = z.infer<typeof evaluationDraftSchema>;
export const defaultWeights = {
  impact: 30,
  alignment: 25,
  feasibility: 20,
  reusability: 15,
  timing: 10,
};
export function potential(
  ratings: z.infer<typeof ratingSchema>,
  weights = defaultWeights,
) {
  const r = ratingSchema.parse(ratings),
    w = weightSchema.parse(weights);
  return Math.round(
    dimensions.reduce((sum, k) => sum + ((r[k] - 1) * w[k]) / 4, 0),
  );
}
export const evaluationCommandSchema = z
  .object({
    ideaId: uuid,
    expectedRevision: z.string().min(1).max(300),
    draft: evaluationDraftSchema,
    applyToIdea: z.boolean(),
    replaceManualScore: z.boolean().default(false),
    overrideReason: z.string().trim().max(2000).default(""),
  })
  .strict();
export type EvaluationCommand = z.infer<typeof evaluationCommandSchema>;
export function validateProjection(command: EvaluationCommand, idea: Idea) {
  if (idea.revision !== command.expectedRevision) throw new Error("STALE_IDEA");
  if (
    command.applyToIdea &&
    idea.scoreAuthority === "manual-approved" &&
    (!command.replaceManualScore || !command.overrideReason)
  )
    throw new Error("MANUAL_SCORE_PROTECTED");
}
export const draftFileSchema = z
  .object({
    format: z.literal("idea-lab-evaluation"),
    version: z.literal(1),
    ideaId: uuid.nullable(),
    inputRevision: z.string().min(1).max(300).nullable(),
    draft: evaluationDraftSchema,
  })
  .strict()
  .refine(
    (v) => Boolean(v.ideaId) === Boolean(v.inputRevision),
    "A linked draft needs its input revision.",
  );
export function decodeDraftFile(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > 100000)
    throw new Error("Choose an evaluation draft smaller than 100 KB.");
  try {
    return draftFileSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      "This evaluation file is invalid or uses an unsupported version.",
    );
  }
}
// Provider output is untrusted. It cannot contain active-score, approval or tool fields.
export const aiAssessmentSchema = evaluationDraftSchema
  .extend({
    modelIdentifier: z.string().trim().min(1).max(200),
    promptVersion: z.string().trim().min(1).max(100),
    inputRevision: z.string().trim().min(1).max(300),
  })
  .strict();
