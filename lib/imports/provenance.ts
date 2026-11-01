import { z } from "zod";
export const sourceSystems = [
  "ChatGPT",
  "Claude",
  "Claude Code",
  "Codex",
  "Notion",
] as const;
export const importSourceSchema = z
  .object({
    system: z.enum(sourceSystems),
    conversationId: z.string().min(1).max(300),
    messageId: z.string().min(1).max(300),
    locator: z.string().min(1).max(1000),
    originalUrl: z
      .string()
      .url()
      .max(2000)
      .refine((v) => ["https:", "http:"].includes(new URL(v).protocol))
      .nullable(),
    conversationDate: z.string().datetime({ offset: true }).nullable(),
    adapterVersion: z.string().min(1).max(100),
    role: z.enum(["user", "assistant", "document"]),
    originRevision: z.string().datetime({ offset: true }).optional(),
    evidence: z.string().trim().min(1).max(6000),
  })
  .strict()
  .superRefine((v, c) => {
    if (
      v.system === "Notion" &&
      (v.role !== "document" ||
        !v.originRevision ||
        !z.string().uuid().safeParse(v.conversationId).success ||
        !(
          (v.messageId.startsWith("property:") &&
            v.messageId.length > 9 &&
            v.messageId.length <= 209) ||
          z.string().uuid().safeParse(v.messageId).success
        ) ||
        v.adapterVersion !== "notion-selected-v1")
    )
      c.addIssue({
        code: "custom",
        message:
          "Notion content needs a page identity, document role and origin revision.",
      });
    if (v.system !== "Notion" && (v.role === "document" || v.originRevision))
      c.addIssue({
        code: "custom",
        message: "Conversation imports cannot impersonate a Notion document.",
      });
  })
  .transform((v) =>
    v.system === "Notion"
      ? {
          ...v,
          conversationId: v.conversationId.toLowerCase(),
          messageId: v.messageId.startsWith("property:")
            ? v.messageId
            : v.messageId.toLowerCase(),
        }
      : v,
  );
export type ImportSource = z.infer<typeof importSourceSchema>;
export async function sha256(text: string) {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
    ),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function sourceIdentity(
  source: Pick<ImportSource, "system" | "conversationId" | "messageId">,
) {
  if (source.system !== "Notion")
    return [source.system, source.conversationId, source.messageId];
  if (!source.messageId.startsWith("property:"))
    return ["Notion", "block", source.messageId.toLowerCase()];
  let propertyId = source.messageId.slice("property:".length);
  try {
    propertyId = decodeURIComponent(propertyId);
  } catch {}
  return [
    "Notion",
    "page-property",
    source.conversationId.toLowerCase(),
    propertyId,
  ];
}
export async function sourceKey(source: ImportSource) {
  return "import:" + (await sha256(JSON.stringify(sourceIdentity(source))));
}
export async function sourceRevision(source: ImportSource) {
  return sha256(
    JSON.stringify([
      source.role,
      source.evidence,
      source.conversationDate,
      source.originalUrl,
      source.locator,
      source.adapterVersion,
      ...(source.originRevision ? [source.originRevision] : []),
    ]),
  );
}
