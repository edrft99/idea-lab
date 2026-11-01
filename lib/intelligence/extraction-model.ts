import { z } from "zod";
import { editableIdeaSchema } from "../ideas/domain";
import { importSourceSchema } from "../imports/provenance";
import { aiResultSchema } from "./model";
export const extractionPromptVersion = "extraction-v1" as const;
export const aiExtractionRequestSchema = z
  .object({ source: importSourceSchema })
  .strict();
export type AIExtractionRequest = z.infer<typeof aiExtractionRequestSchema>;
export const extractedDataSchema = editableIdeaSchema
  .pick({
    title: true,
    summary: true,
    problem: true,
    solution: true,
    audience: true,
    expectedValue: true,
    context: true,
    category: true,
    nextAction: true,
  })
  .strict();
const classification = z.enum(["Idea", "Routine", "Uncertain"]);
export const modelExtractionSchema = z
  .object({
    classification,
    rationale: z.string().trim().min(1).max(2000),
    confidence: z.number().finite().min(0).max(1),
    data: extractedDataSchema.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      (v.classification !== "Idea" || !!v.data) &&
      (v.classification !== "Routine" || v.data === null),
    "Idea requires a candidate; Routine must not include one.",
  );
const metadata = aiResultSchema.omit({
  format: true,
  version: true,
  ideaId: true,
  inputRevision: true,
  input: true,
  draft: true,
  promptVersion: true,
});
export const aiExtractionResultSchema = metadata
  .extend({
    format: z.literal("idea-lab-ai-extraction"),
    version: z.literal(1),
    promptVersion: z.literal(extractionPromptVersion),
    input: aiExtractionRequestSchema,
    sourceKey: z.string().regex(/^import:[a-f0-9]{64}$/),
    sourceRevision: z.string().regex(/^[a-f0-9]{64}$/),
    classification,
    rationale: z.string().trim().min(1).max(2000),
    confidence: z.number().finite().min(0).max(1),
    data: editableIdeaSchema.nullable(),
  })
  .strict()
  .refine(
    (v) =>
      (v.classification !== "Idea" || !!v.data) &&
      (v.classification !== "Routine" || v.data === null),
  );
export type AIExtractionResult = z.infer<typeof aiExtractionResultSchema>;
