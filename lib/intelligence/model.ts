import { z } from "zod";
import { uuid } from "../ideas/domain";
import { weightSchema, evaluationDraftSchema } from "../evaluations/model";
export const selectedFields = [
  "title",
  "summary",
  "problem",
  "solution",
  "audience",
  "expectedValue",
  "context",
] as const;
export const selectionSchema = z
  .object(
    Object.fromEntries(
      selectedFields.map((k) => [
        k,
        z.string().trim().min(1).max(3000).optional(),
      ]),
    ) as Record<(typeof selectedFields)[number], z.ZodOptional<z.ZodString>>,
  )
  .strict()
  .refine(
    (v) =>
      Object.keys(v).length > 0 &&
      new TextEncoder().encode(JSON.stringify(v)).byteLength <= 12000,
    "Select 1–7 excerpts totaling at most 12 KB.",
  );
export const aiEvaluationRequestSchema = z
  .object({
    ideaId: uuid,
    inputRevision: z.string().min(1).max(300),
    selection: selectionSchema,
    rubricVersion: z.string().trim().min(1).max(100),
    weights: weightSchema,
  })
  .strict();
export type AIEvaluationRequest = z.infer<typeof aiEvaluationRequestSchema>;
export const modelAssessmentSchema = evaluationDraftSchema
  .omit({ rubricVersion: true, weights: true })
  .strict();
export const aiResultSchema = z
  .object({
    format: z.literal("idea-lab-ai-assessment"),
    version: z.literal(1),
    runId: z.string().regex(/^[a-f0-9]{64}$/),
    ideaId: uuid,
    inputRevision: z.string().min(1).max(300),
    inputHash: z.string().regex(/^[a-f0-9]{64}$/),
    input: aiEvaluationRequestSchema,
    draft: evaluationDraftSchema,
    provider: z.literal("azure-openai-responses"),
    endpoint: z.string().url(),
    deployment: z.string().min(1).max(200),
    retentionNotice: z.string().min(1).max(2000),
    maxOutputTokens: z.number().int().min(2000).max(8000),
    resolvedModel: z.string().min(1).max(200),
    promptVersion: z.literal("assessment-v1"),
    responseId: z.string().min(1).max(200),
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
  .strict();
export type AIResult = z.infer<typeof aiResultSchema>;
