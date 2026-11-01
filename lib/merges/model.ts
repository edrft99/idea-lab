import { z } from "zod";
import { uuid, statuses, type Idea, editable } from "../ideas/domain";
import { digest } from "../ideas/operations";
export const mergeCommandSchema = z
  .object({
    survivorId: uuid,
    survivorRevision: z.string().min(1).max(300),
    candidates: z
      .array(
        z.object({ id: uuid, revision: z.string().min(1).max(300) }).strict(),
      )
      .min(1)
      .max(5),
    reason: z.string().trim().min(1).max(4000),
    preserveOriginals: z.literal(true),
  })
  .strict()
  .superRefine((v, c) => {
    const ids = [v.survivorId, ...v.candidates.map((i) => i.id)];
    if (new Set(ids).size !== ids.length)
      c.addIssue({
        code: "custom",
        message: "Choose a survivor and distinct candidates.",
      });
  });
export type MergeCommand = z.infer<typeof mergeCommandSchema>;
const beforeSchema = z
  .object({
    id: uuid,
    revision: z.string().min(1).max(300),
    status: z.enum(statuses),
    canonicalId: uuid.nullable(),
    related: z.array(uuid).max(100),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export const mergeJournalSchema = z
  .object({
    format: z.literal("idea-lab-merge"),
    version: z.literal(1),
    operation: z.string().regex(/^[a-f0-9]{64}$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    command: mergeCommandSchema,
    actor: z.string().min(1),
    before: z.array(beforeSchema).min(2).max(6),
  })
  .strict()
  .superRefine((v, c) => {
    const refs = [
      { id: v.command.survivorId, revision: v.command.survivorRevision },
      ...v.command.candidates,
    ];
    if (
      refs.length !== v.before.length ||
      refs.some(
        (r, n) =>
          r.id !== v.before[n]?.id || r.revision !== v.before[n]?.revision,
      )
    )
      c.addIssue({
        code: "custom",
        message: "Merge journal inputs differ from approval.",
      });
    if (v.before.some((b) => b.canonicalId !== null))
      c.addIssue({
        code: "custom",
        message: "Superseded inputs cannot be merged.",
      });
  });
export type MergeJournal = z.infer<typeof mergeJournalSchema>;
export function originalSnapshot(idea: Idea) {
  return {
    id: idea.id,
    revision: idea.revision,
    description: editable(idea),
    scores: idea.scores,
    priorityScore: idea.priorityScore,
    confidence: idea.confidence,
    scoreAuthority: idea.scoreAuthority,
    sourceIds: idea.sourceIds,
    sourceReferences: idea.sources.map((s) => ({
      id: s.id,
      system: s.system,
      identifier: s.identifier,
      url: s.url,
    })),
    latestEvaluationId: idea.latestEvaluationId,
    relatedIdeaIds: idea.relatedIdeaIds,
    canonicalIdeaId: idea.canonicalIdeaId,
    createdAt: idea.createdAt,
    lastReviewed: idea.lastReviewed,
  };
}
export function mergeContentHash(idea: Idea) {
  const {
    revision,
    updatedAt,
    status,
    canonicalIdeaId,
    relatedIdeaIds,
    ...content
  } = idea;
  return digest(JSON.stringify(content));
}
export async function mergeBefore(
  ideas: Idea[],
): Promise<MergeJournal["before"]> {
  return Promise.all(
    ideas.map(async (i) => ({
      id: i.id,
      revision: i.revision,
      status: i.status,
      canonicalId: i.canonicalIdeaId,
      related: i.relatedIdeaIds,
      contentHash: await mergeContentHash(i),
      snapshotHash: await digest(JSON.stringify(originalSnapshot(i))),
    })),
  );
}
export const mergeTarget = (command: MergeCommand) =>
  "merge:" + command.survivorId;
export function desiredRelated(journal: MergeJournal, index: number) {
  return index === 0
    ? [
        ...new Set([
          ...journal.before[0].related,
          ...journal.command.candidates.map((c) => c.id),
        ]),
      ].sort()
    : journal.before[index].related;
}
