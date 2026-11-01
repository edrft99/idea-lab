import { aiExtractionResultSchema } from "../intelligence/extraction-model";
import { z } from "zod";
import { editableIdeaSchema, uuid, type Idea } from "../ideas/domain";
import { importSourceSchema } from "../imports/provenance";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const storeProposalSchema = z
  .object({
    data: editableIdeaSchema,
    source: importSourceSchema,
    ai: aiExtractionResultSchema.optional(),
    aiOverrideReason: z.string().trim().max(2000).optional(),
    note: z.string().trim().min(1).max(2000),
    reconsider: z.boolean().default(false),
    reconsiderReason: z.string().trim().max(2000).default(""),
  })
  .strict()
  .refine(
    (v) => !v.reconsider || !!v.reconsiderReason,
    "Explain why this source revision should be reconsidered.",
  )
  .refine(
    (v) => !v.ai || v.ai.classification === "Idea" || !!v.aiOverrideReason,
    "Explain why you are overriding the Routine or Uncertain AI classification.",
  );
export type StoreProposal = z.infer<typeof storeProposalSchema>;
export const proposalDecisionSchema = z.discriminatedUnion("decision", [
  z
    .object({
      decision: z.literal("Approve"),
      proposalId: uuid,
      proposalRevision: hash,
      data: editableIdeaSchema,
      reason: z.string().trim().min(1).max(2000),
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
export type ProposalDecision = z.infer<typeof proposalDecisionSchema>;
export const storedProposalSchema = z
  .object({
    format: z.literal("idea-lab-extraction-proposal"),
    version: z.literal(1),
    operation: hash,
    actor: z.string().min(1),
    command: storeProposalSchema,
    commandHash: hash,
    sourceKey: z.string().regex(/^import:[a-f0-9]{64}$/),
    sourceRevision: hash,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type StoredProposal = z.infer<typeof storedProposalSchema>;
export const decisionRecordSchema = z
  .object({
    decision: z.enum(["Approve", "Reject"]),
    reason: z.string().min(1).max(2000),
    operation: hash,
    intentId: uuid,
    ideaId: uuid.nullable(),
  })
  .strict()
  .refine(
    (v) => (v.decision === "Approve") === !!v.ideaId,
    "A canonical result is required only for approval.",
  );
export const proposalIntentSchema = z
  .object({
    format: z.literal("idea-lab-extraction-decision"),
    version: z.literal(1),
    operation: hash,
    actor: z.string().min(1),
    command: proposalDecisionSchema,
    payloadHash: hash,
    proposal: storedProposalSchema,
    createdAt: z.string().datetime({ offset: true }),
  })
  .strict();
export type ProposalIntent = z.infer<typeof proposalIntentSchema>;
export interface ExtractionProposal {
  id: string;
  url: string | null;
  status: "Pending" | "Approved" | "Rejected";
  revision: string;
  snapshot: StoredProposal;
  decision: z.infer<typeof decisionRecordSchema> | null;
  canonicalIdeaId: string | null;
}
export interface ProposalSaveResult {
  reviewId: string;
  idea?: Idea;
  replayed: boolean;
}
