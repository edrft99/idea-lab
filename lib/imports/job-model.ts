import { z } from "zod";
import { commandSchema } from "../ideas/domain";
export const jobId = z.string().uuid();
export const jobHash = z.string().regex(/^[a-f0-9]{64}$/);
export const jobSourceKey = z.string().regex(/^import:[a-f0-9]{64}$/);
export const importCommand = commandSchema.refine(
  (c) => c.action === "create" && !!c.source,
  "An import requires a selected source and a create command.",
);
export const jobManifestItem = z
  .object({ id: jobId, sourceKey: jobSourceKey, sourceRevision: jobHash })
  .strict();
export const createImportJob = z
  .object({
    requestKey: jobId,
    items: z.array(jobManifestItem).min(1).max(100),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      new Set(v.items.map((i) => i.id)).size !== v.items.length ||
      new Set(v.items.map((i) => i.sourceKey)).size !== v.items.length
    )
      c.addIssue({
        code: "custom",
        message: "An import job cannot repeat item or source identities.",
      });
  });
export type ImportManifest = z.infer<typeof createImportJob>;
export const jobRow = z.object({
  id: jobId,
  owner_hash: jobHash,
  request_key: jobId,
  manifest_hash: jobHash,
  status: z.enum(["active", "paused", "cancelled"]),
  created_at: z.number(),
  updated_at: z.number(),
  expires_at: z.number(),
});
export const jobItemRow = z.object({
  job_id: jobId,
  id: jobId,
  source_key: jobSourceKey,
  source_revision: jobHash,
  status: z.enum(["waiting", "review", "running", "check", "done", "failed"]),
  operation_id: jobHash.nullable(),
  attempts: z.number().int().min(0),
  phase: z.enum([
    "not_started",
    "idea_dispatched",
    "idea_confirmed",
    "idea_rejected",
    "source_dispatched",
    "source_rejected",
    "source_confirmed",
  ]),
  lease_hash: jobHash.nullable(),
  lease_until: z.number(),
  not_before: z.number(),
  last_code: z.string().nullable(),
  idea_id: jobId.nullable(),
  idea_revision: z.string().nullable(),
  source_id: jobId.nullable(),
});
export type ImportJob = z.infer<typeof jobRow>;
export type ImportItem = z.infer<typeof jobItemRow>;
export type ImportJobView = {
  id: string;
  status: ImportJob["status"];
  createdAt: string;
  expiresAt: string;
  expired: boolean;
  items: Array<{
    id: string;
    sourceKey: string;
    sourceRevision: string;
    status: ImportItem["status"];
    phase: ImportItem["phase"];
    attempts: number;
    attemptLimit: number;
    notBefore: string | null;
    lastCode: string | null;
    ideaId: string | null;
    operationId: string | null;
    payloadHash: string | null;
    leaseActive: boolean;
    recoverable: boolean;
  }>;
};
export const importAttemptLimit = 3;
export const importLeaseMs = 120000;
export const importRetentionMs = 30 * 86400000;
