import { z } from "zod";
import { uuid } from "../ideas/domain";
import { fieldsSchema, inputVersion } from "./semantic-model";
export const snapshotHash = z.string().regex(/^[a-f0-9]{64}$/);
export const snapshotPlanSchema = z
  .object({
    scope: z.literal("all-current-canonical-ideas"),
    fields: fieldsSchema,
  })
  .strict();
export const snapshotBatchSchema = z
  .object({ snapshotId: snapshotHash, ideaIds: z.array(uuid).min(1).max(20) })
  .strict()
  .refine(
    (c) => new Set(c.ideaIds).size === c.ideaIds.length,
    "Choose each record once.",
  )
  .transform((c) => ({ ...c, ideaIds: [...c.ideaIds].sort() }));
export const snapshotChoiceSchema = z
  .object({ snapshotId: snapshotHash })
  .strict();
export const snapshotRecordSchema = z
  .object({ id: uuid, inputHash: snapshotHash, revision: snapshotHash })
  .strict();
export const snapshotRecordsSchema = z
  .array(snapshotRecordSchema)
  .max(1000)
  .refine((r) => new Set(r.map((i) => i.id)).size === r.length);
export const snapshotDescriptorSchema = z
  .object({
    endpoint: z.string().url().max(300),
    deployment: z.string().min(1).max(200),
    dimensions: z.number().int().min(1).max(4096),
    versionLabel: z.string().min(1).max(100),
    inputVersion: z.literal(inputVersion),
  })
  .strict();
export type SnapshotPlan = z.infer<typeof snapshotPlanSchema>;
export type SnapshotBatch = z.infer<typeof snapshotBatchSchema>;
export type SnapshotChoice = z.infer<typeof snapshotChoiceSchema>;
export type SnapshotRecord = z.infer<typeof snapshotRecordSchema>;
export { snapshotActions, semanticActions } from "./semantic-actions";

import { digest } from "../ideas/operations";
export const snapshotManifestHash = (
  records: SnapshotRecord[],
  fields: string[],
) =>
  digest(
    JSON.stringify(
      records
        .map(({ id, inputHash, revision }) => ({
          id,
          inputHash,
          revision,
          fields,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
export const snapshotStorageProfile = (id: string, profile: string) =>
  digest(JSON.stringify(["snapshot-v1", id, profile]));

export const snapshotPlanContext = z
  .object({
    version: z.literal(1),
    profile: snapshotHash,
    context: snapshotHash,
    manifest: snapshotHash,
    count: z.number().int().min(0).max(1000),
  })
  .strict();
export const snapshotActivationContext = z
  .object({
    snapshotId: snapshotHash,
    cacheProfile: snapshotHash,
    manifest: snapshotHash,
    profile: snapshotHash,
    context: snapshotHash,
    vectorsHash: snapshotHash,
    model: z.string().min(1).max(200).nullable(),
    previous: z
      .object({ snapshotId: snapshotHash, operationId: snapshotHash })
      .strict()
      .nullable(),
  })
  .strict();
export const snapshotDiscardContext = z
  .object({
    snapshotId: snapshotHash,
    cacheProfile: snapshotHash,
    fingerprint: snapshotHash,
  })
  .strict();
