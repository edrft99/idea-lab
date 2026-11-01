import { aiResultSchema } from "../intelligence/model";
import { z } from "zod";
import { uuid, editableIdeaSchema } from "../ideas/domain";
import { digest } from "../ideas/operations";
import { evaluationDraftSchema } from "./model";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const assessmentStoreSchema = z
  .object({
    ideaId: uuid,
    inputRevision: z.string().min(1).max(300),
    draft: evaluationDraftSchema,
    ai: aiResultSchema.optional(),
    note: z.string().trim().min(1).max(2000),
    reconsider: z.boolean().default(false),
    reconsiderReason: z.string().trim().max(2000).default(""),
  })
  .strict()
  .refine(
    (v) => !v.reconsider || !!v.reconsiderReason,
    "Explain why this assessment should be reconsidered.",
  );
export type AssessmentStore = z.infer<typeof assessmentStoreSchema>;
export const assessmentDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("Approve"),
      proposalId: uuid,
      proposalRevision: hash,
      reason: z.string().trim().min(1).max(2000),
      applyToIdea: z.boolean(),
      replaceManualScore: z.boolean().default(false),
      overrideReason: z.string().trim().max(2000).default(""),
    })
    .strict(),
  z
    .object({
      decision: z.literal("Reject"),
      proposalId: uuid,
      proposalRevision: hash,
      reason: z.string().trim().min(1).max(2000),
    })
    .strict(),
]);
export type AssessmentDecision = z.infer<typeof assessmentDecisionSchema>;
export const assessmentSnapshotSchema = z
  .object({
    format: z.literal("idea-lab-assessment-proposal"),
    version: z.literal(1),
    operation: hash,
    actor: z.string().min(1),
    command: assessmentStoreSchema,
    commandHash: hash,
    key: z.string().regex(/^assessment:[a-f0-9]{64}$/),
    input: editableIdeaSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AssessmentSnapshot = z.infer<typeof assessmentSnapshotSchema>;
export const assessmentIntentSchema = z
  .object({
    format: z.literal("idea-lab-assessment-decision"),
    version: z.literal(1),
    operation: hash,
    actor: z.string().min(1),
    command: assessmentDecisionSchema,
    payloadHash: hash,
    proposal: assessmentSnapshotSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type AssessmentIntent = z.infer<typeof assessmentIntentSchema>;
export const assessmentResolutionSchema = z
  .object({
    decision: z.enum(["Approve", "Reject"]),
    reason: z.string().min(1).max(2000),
    operation: hash,
    intentId: uuid,
    evaluationId: uuid.nullable(),
  })
  .strict()
  .refine((v) => (v.decision === "Approve") === !!v.evaluationId);
export interface AssessmentProposal {
  id: string;
  url: string | null;
  status: "Pending" | "Approved" | "Rejected";
  revision: string;
  snapshot: AssessmentSnapshot;
  decision: z.infer<typeof assessmentResolutionSchema> | null;
}
export async function assessmentKey(
  ideaId: string,
  inputRevision: string,
  draft: z.infer<typeof evaluationDraftSchema>,
) {
  return (
    "assessment:" +
    (await digest(
      JSON.stringify([
        ideaId,
        inputRevision,
        evaluationDraftSchema.parse(draft),
      ]),
    ))
  );
}
