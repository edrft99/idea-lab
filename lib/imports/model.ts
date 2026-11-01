import { aiExtractionResultSchema } from "../intelligence/extraction-model";
import { z } from "zod";
import { editableIdeaSchema } from "../ideas/domain";
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_TURNS = 20000;
import {
  importSourceSchema,
  sourceIdentity,
  type ImportSource,
} from "./provenance";
export * from "./provenance";
export interface Turn {
  id: string;
  messageId: string;
  parentId: string | null;
  role: "user" | "assistant" | "document";
  originRevision?: string;
  locator?: string;
  originalUrl?: string | null;
  text: string;
  date: string | null;
}
export interface Branch {
  id: string;
  label: string;
  turnIds: string[];
  current: boolean;
}
export interface Conversation {
  id: string;
  title: string;
  system: ImportSource["system"];
  url: string | null;
  adapterVersion: string;
  turns: Turn[];
  branches: Branch[];
}
export interface ParsedImport {
  conversations: Conversation[];
  warnings: string[];
  ignored: number;
}
export const proposalSchema = z
  .object({
    id: z.string().uuid(),
    data: editableIdeaSchema,
    source: importSourceSchema,
    ai: aiExtractionResultSchema.optional(),
    decision: z.enum(["draft", "rejected", "saved"]).default("draft"),
    canonicalId: z.string().uuid().nullable().default(null),
  })
  .strict();
export type Proposal = z.infer<typeof proposalSchema>;
export const checkpointSchema = z
  .object({
    format: z.literal("idea-lab-import-review"),
    version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    jobId: z.string().uuid().optional(),
    createdAt: z.string().datetime({ offset: true }),
    proposals: z.array(proposalSchema).max(100),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.jobId && v.version !== 3)
      ctx.addIssue({
        code: "custom",
        message: "Job references require progress version 3.",
      });
    if (v.version === 3 && !v.jobId)
      ctx.addIssue({
        code: "custom",
        message: "Progress version 3 requires its job reference.",
      });
    const ids = new Set<string>(),
      sources = new Set<string>();
    for (const p of v.proposals) {
      if (
        p.ai &&
        JSON.stringify(p.ai.input.source) !== JSON.stringify(p.source)
      )
        ctx.addIssue({
          code: "custom",
          message: "AI extraction source differs from the draft source.",
        });
      if (ids.has(p.id))
        ctx.addIssue({ code: "custom", message: "Duplicate proposal IDs" });
      ids.add(p.id);
      const key = JSON.stringify(sourceIdentity(p.source));
      if (sources.has(key))
        ctx.addIssue({
          code: "custom",
          message: "Duplicate source identities",
        });
      sources.add(key);
    }
  });
export function downloadCheckpoint(proposals: Proposal[], jobId?: string) {
  const serialized = JSON.stringify(
    checkpointSchema.parse({
      format: "idea-lab-import-review",
      version: jobId ? 3 : 2,
      ...(jobId ? { jobId } : {}),
      createdAt: new Date().toISOString(),
      proposals,
    }),
    null,
    2,
  );
  if (new TextEncoder().encode(serialized).byteLength > MAX_FILE_BYTES)
    throw new Error(
      "The private progress file would exceed 10 MB. Save or reduce this batch before downloading.",
    );
  return serialized;
}
export function readCheckpoint(raw: string) {
  if (new TextEncoder().encode(raw).byteLength > MAX_FILE_BYTES)
    throw new Error("Checkpoint exceeds the 10 MB limit.");
  try {
    return checkpointSchema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      "This review file is invalid or uses an unsupported version. Existing drafts are unchanged.",
    );
  }
}
