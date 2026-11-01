import { z } from "zod";
import { uuid, type Idea, type EditableIdea } from "../ideas/domain";
import { digest } from "../ideas/operations";
export const relationships = [
  "Duplicate",
  "Refinement",
  "Related",
  "Distinct",
  "Uncertain",
] as const;
export const decisions = [
  "Duplicate",
  "Refinement",
  "Related",
  "Distinct",
  "Reject",
] as const;
export const comparisonFields = [
  "title",
  "summary",
  "problem",
  "solution",
  "audience",
  "expectedValue",
  "context",
] as const;
export type ComparisonField = (typeof comparisonFields)[number];
export const comparisonLabels: Record<ComparisonField, string> = {
  title: "Title",
  summary: "Summary",
  problem: "Problem statement",
  solution: "Proposed solution",
  audience: "Intended audience",
  expectedValue: "Expected value",
  context: "Relevant context",
};
const revision = z.string().min(1).max(300);
export const pairQuerySchema = z
  .object({ candidateId: uuid, matchingId: uuid })
  .strict()
  .refine((v) => v.candidateId !== v.matchingId, "Choose two different ideas.");
export const decisionCommandSchema = z
  .object({
    candidateId: uuid,
    matchingId: uuid,
    candidateRevision: revision,
    matchingRevision: revision,
    reviewId: uuid.nullable().default(null),
    reviewRevision: revision.nullable().default(null),
    decision: z.enum(decisions),
    reason: z.string().trim().min(1).max(4000),
    reconsider: z.boolean().default(false),
  })
  .strict()
  .superRefine((v, c) => {
    if (v.candidateId === v.matchingId)
      c.addIssue({ code: "custom", message: "Choose two different ideas." });
    if (Boolean(v.reviewId) !== Boolean(v.reviewRevision))
      c.addIssue({
        code: "custom",
        message: "Review identity and revision must be supplied together.",
      });
  });
export type DecisionCommand = z.infer<typeof decisionCommandSchema>;
export const fingerprint = (idea: Pick<EditableIdea, ComparisonField>) =>
  digest(
    JSON.stringify(
      comparisonFields.map((k) =>
        idea[k].normalize("NFC").replace(/\r\n/g, "\n").trim(),
      ),
    ),
  );
export async function pairKey(a: string, b: string) {
  return (
    "pair:" +
    (await digest(JSON.stringify([a.toLowerCase(), b.toLowerCase()].sort())))
  );
}
export const snapshotSchema = z
  .object({
    format: z.literal("idea-lab-relationship"),
    version: z.literal(1),
    candidateId: uuid,
    matchingId: uuid,
    candidateRevision: z.string().max(300),
    matchingRevision: z.string().max(300),
    candidateHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    matchingHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    decision: z.enum(decisions),
    reason: z.string().min(1).max(4000),
    operation: z.string().regex(/^[a-f0-9]{64}$/),
    origin: z.literal("manual"),
    scope: z.literal("classification-only"),
    originalReviewId: uuid.nullable(),
  })
  .strict();
export type DecisionSnapshot = z.infer<typeof snapshotSchema>;
export interface RelationshipReview {
  id: string;
  url: string | null;
  title: string;
  status: "Pending" | "Approved" | "Rejected";
  type: string | null;
  candidateId: string | null;
  matchingId: string | null;
  candidateRevision: string;
  matchingRevision: string;
  revision: string;
  pairKey: string;
  reasoning: string;
  recommendation: string | null;
  similarity: number | null;
  decision: string;
  operation: string;
  reviewedAt: string | null;
  updatedAt: string;
  snapshot: DecisionSnapshot | null;
}
export interface PairContext {
  candidate: Idea;
  matching: Idea;
  key: string;
  candidateHash: string;
  matchingHash: string;
  history: RelationshipReview[];
  priorDecision: RelationshipReview | null;
  reopened: boolean;
  review: RelationshipReview | null;
  staleProposal: boolean;
}
export function sameContent(
  record: RelationshipReview,
  context: Pick<
    PairContext,
    "candidate" | "matching" | "candidateHash" | "matchingHash"
  >,
) {
  const a = context.candidate,
    b = context.matching,
    s = record.snapshot;
  if (record.candidateId === a.id && record.matchingId === b.id) {
    if (s?.candidateHash && s.matchingHash)
      return (
        s.candidateHash === context.candidateHash &&
        s.matchingHash === context.matchingHash
      );
    return (
      record.candidateRevision === a.revision &&
      record.matchingRevision === b.revision
    );
  }
  if (record.candidateId === b.id && record.matchingId === a.id) {
    if (s?.candidateHash && s.matchingHash)
      return (
        s.candidateHash === context.matchingHash &&
        s.matchingHash === context.candidateHash
      );
    return (
      record.candidateRevision === b.revision &&
      record.matchingRevision === a.revision
    );
  }
  return false;
}
export const relationshipOutputSchema = z
  .object({
    relationship: z.enum(relationships),
    reasoning: z.string().trim().min(1).max(4000),
    confidence: z.number().finite().min(0).max(1),
    evidence: z
      .array(
        z
          .object({
            ideaId: uuid,
            field: z.enum(comparisonFields),
            quote: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .min(2)
      .max(20),
  })
  .strict();
export function validateClassification(raw: unknown, a: Idea, b: Idea) {
  const value = relationshipOutputSchema.parse(raw);
  if (
    !value.evidence.some((e) => e.ideaId === a.id) ||
    !value.evidence.some((e) => e.ideaId === b.id)
  )
    throw new Error("Evidence must cite both retrieved ideas.");
  for (const e of value.evidence) {
    const idea = e.ideaId === a.id ? a : e.ideaId === b.id ? b : null;
    if (!idea || !idea[e.field].includes(e.quote))
      throw new Error("The classification contains unsupported evidence.");
  }
  return value;
}
// A local triage hint. It is neither embedding similarity nor a relationship verdict.
const stop = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "have",
  "would",
  "could",
  "should",
  "want",
  "build",
  "create",
  "idea",
  "tool",
  "app",
  "system",
  "you",
  "your",
  "our",
  "are",
  "will",
  "can",
]);
function terms(idea: Pick<EditableIdea, ComparisonField>) {
  const text = comparisonFields
    .map((k) => idea[k])
    .join(" ")
    .slice(0, 50000)
    .normalize("NFKC")
    .toLowerCase();
  return new Set(
    (text.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
      (t) => t.length > 2 && !stop.has(t),
    ),
  );
}
export function textOverlap(
  a: Pick<EditableIdea, ComparisonField>,
  b: Pick<EditableIdea, ComparisonField>,
) {
  const left = terms(a),
    right = terms(b),
    shared = [...left].filter((t) => right.has(t)).sort(),
    union = new Set([...left, ...right]).size;
  return {
    score: union ? shared.length / union : 0,
    shared: shared.slice(0, 30),
    method: "word-overlap-v1" as const,
  };
}
