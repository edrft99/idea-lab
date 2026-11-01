import { z } from "zod";
import {
  editableIdeaSchema,
  uuid,
  commandSchema,
  filtersSchema,
} from "../ideas/domain";
export const captureClients = [
  "ChatGPT",
  "Claude",
  "Claude Code",
  "Codex",
] as const;
export const captureId = z.string().regex(/^[a-f0-9]{64}$/);
export const captureOriginSchema = z
  .object({
    conversationId: z.string().trim().min(1).max(300).optional(),
    messageId: z.string().trim().min(1).max(300).optional(),
    locator: z.string().trim().min(1).max(1000).optional(),
    url: z
      .string()
      .url()
      .max(2000)
      .refine((v) => new URL(v).protocol === "https:")
      .optional(),
    conversationDate: z.string().datetime({ offset: true }).optional(),
    role: z.enum(["user", "assistant"]).default("user"),
  })
  .strict();
export const proposeCaptureSchema = z
  .object({
    captureId: uuid,
    client: z.enum(captureClients),
    data: editableIdeaSchema,
    evidence: z.string().trim().min(1).max(6000),
    origin: captureOriginSchema.optional(),
  })
  .strict();
export const updateCaptureSchema = z
  .object({
    captureId: uuid,
    client: z.enum(captureClients),
    id: uuid,
    expectedRevision: z.string().min(1).max(300),
    data: editableIdeaSchema,
  })
  .strict();
export const captureChoiceSchema = z.object({ proposalId: captureId }).strict();
export const searchCaptureSchema = z
  .object({
    query: z.string().trim().max(300).default(""),
    filters: filtersSchema
      .omit({ query: true, sort: true })
      .strict()
      .default({}),
    limit: z.number().int().min(1).max(20).default(10),
  })
  .strict();
export const similarCaptureSchema = z
  .object({
    text: z.string().trim().min(1).max(2000),
    limit: z.number().int().min(1).max(20).default(5),
  })
  .strict();
export type ProposeCapture = z.infer<typeof proposeCaptureSchema>;
export type UpdateCapture = z.infer<typeof updateCaptureSchema>;
export const storedCaptureSchema = z
  .object({
    client: z.enum(captureClients),
    requestHash: captureId,
    command: commandSchema,
  })
  .strict();
export type StoredCapture = z.infer<typeof storedCaptureSchema>;
export const captureRetention =
  "Only this selected draft is staged privately for five minutes. It is inaccessible from the server after expiry and its payload is cleared after save/rejection or on subsequent capture access. There is no unattended cleanup job yet. Nothing is canonical until the reviewed Notion save completes.";
