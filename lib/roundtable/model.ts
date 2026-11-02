import { z } from "zod";
import { uuid } from "../ideas/domain";
import { selectionSchema } from "../intelligence/model";
export const rubricVersion = "viability-v1" as const;
export const promptVersion = "roundtable-independent-v1" as const;
export const dimensions = ["feasibility", "success", "value"] as const;
export const labels = {
  feasibility: "Feasibility",
  success: "Success",
  value: "Value offered",
};
export const requestSchema = z
  .object({
    ideaId: uuid,
    inputRevision: z.string().min(1).max(300),
    selection: selectionSchema,
    successCriteria: z.string().trim().min(10).max(1500),
    constraints: z.string().trim().min(10).max(1500),
    rubricVersion: z.literal(rubricVersion),
  })
  .strict();
export type RoundtableRequest = z.infer<typeof requestSchema>;
const text = z.string().trim().min(1).max(1500);
const rating = z
  .object({
    score: z.number().int().min(0).max(100).nullable(),
    evidence: text,
  })
  .strict();
export const assessmentSchema = z
  .object({
    verdict: z.enum([
      "Promising",
      "Needs validation",
      "Needs rethinking",
      "Insufficient evidence",
    ]),
    summary: text,
    ratings: z
      .object({ feasibility: rating, success: rating, value: rating })
      .strict(),
    confidence: z.number().min(0).max(1),
    strengths: z.array(text).min(1).max(5),
    risks: z.array(text).min(1).max(5),
    assumptions: z.array(text).min(1).max(5),
    expansions: z.array(text).min(1).max(5),
    experiments: z
      .array(z.object({ experiment: text, successSignal: text }).strict())
      .min(1)
      .max(5),
  })
  .strict();
export type RoundtableAssessment = z.infer<typeof assessmentSchema>;
export function provisionalScore(
  assessment: RoundtableAssessment,
): number | null {
  const scores = dimensions.map((key) => assessment.ratings[key].score);
  return scores.some((score) => score === null)
    ? null
    : Math.round((scores as number[]).reduce((a, b) => a + b, 0) / 3);
}
export const resultSchema = z
  .object({
    format: z.literal("idea-lab-roundtable"),
    version: z.literal(1),
    runId: z.string().regex(/^[a-f0-9]{64}$/),
    participant: z.enum(["gpt", "claude"]),
    stage: z.literal("independent"),
    input: requestSchema,
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    assessment: assessmentSchema,
    provider: z.enum([
      "openai-responses",
      "azure-openai-responses",
      "anthropic-messages",
    ]),
    model: z.string().min(1).max(200),
    resolvedModel: z.string().min(1).max(200),
    endpoint: z.string().url(),
    responseId: z.string().min(1).max(200),
    rubricVersion: z.literal(rubricVersion),
    promptVersion: z.literal(promptVersion),
    requestedAt: z.string().datetime({ offset: true }),
    completedAt: z.string().datetime({ offset: true }),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
      })
      .strict()
      .nullable(),
  })
  .strict()
  .refine(
    (value) =>
      (value.participant === "claude") ===
      (value.provider === "anthropic-messages"),
    { message: "Reviewer and provider do not match" },
  );
export type RoundtableResult = z.infer<typeof resultSchema>;
export function decodeResult(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > 100000)
    throw new Error("Choose a roundtable result smaller than 100 KB.");
  return resultSchema.parse(JSON.parse(raw));
}

export type ActiveReviewer = "gpt" | "claude";
export const reviewerName = (id: ActiveReviewer) =>
  id === "claude" ? "Claude" : "GPT";
