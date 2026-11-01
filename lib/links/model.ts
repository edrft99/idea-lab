import { z } from "zod";
import { uuid, type Idea } from "../ideas/domain";
import { digest } from "../ideas/operations";
export const linkCommandSchema = z
  .object({
    candidateId: uuid,
    matchingId: uuid,
    candidateRevision: z.string().min(1).max(300),
    matchingRevision: z.string().min(1).max(300),
    reason: z.string().trim().min(1).max(4000),
  })
  .strict()
  .refine((v) => v.candidateId !== v.matchingId, "Choose two different ideas.");
export type LinkCommand = z.infer<typeof linkCommandSchema>;
const beforeSchema = z
  .object({
    id: uuid,
    revision: z.string().min(1).max(300),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    related: z.array(uuid).max(100),
  })
  .strict();
export const linkJournalSchema = z
  .object({
    format: z.literal("idea-lab-related-link"),
    version: z.literal(1),
    operation: z.string().regex(/^[a-f0-9]{64}$/),
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
    command: linkCommandSchema,
    actor: z.string().min(1),
    before: z.tuple([beforeSchema, beforeSchema]),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.before[0].id !== v.command.candidateId ||
      v.before[1].id !== v.command.matchingId ||
      v.before[0].revision !== v.command.candidateRevision ||
      v.before[1].revision !== v.command.matchingRevision
    )
      c.addIssue({
        code: "custom",
        message: "Journal inputs differ from approved inputs.",
      });
  });
export type LinkJournal = z.infer<typeof linkJournalSchema>;
// Includes manual scores, source identities and canonical identity. Approval metadata
// and edit time change during a link; all other decoded fields must be preserved.
export function linkContentHash(idea: Idea) {
  const { relatedIdeaIds, revision, updatedAt, ...content } = idea;
  return digest(JSON.stringify(content));
}
export const sameIds = (a: string[], b: string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function linkedIds(journal: LinkJournal, index: 0 | 1) {
  return [
    ...new Set([
      ...journal.before[index].related,
      journal.before[index === 0 ? 1 : 0].id,
    ]),
  ].sort();
}
