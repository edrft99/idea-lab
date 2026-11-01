import { z } from "zod";
import { uuid } from "../ideas/domain";
export function notionReference(value: string): string {
  const raw = value.trim();
  let candidate = raw;
  if (/^https?:/i.test(raw)) {
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new Error("Enter a Notion page URL or ID.");
    }
    if (
      u.protocol !== "https:" ||
      !(
        [
          "notion.so",
          "www.notion.so",
          "app.notion.so",
          "notion.com",
          "www.notion.com",
          "app.notion.com",
        ].includes(u.hostname) || u.hostname.endsWith(".notion.site")
      )
    )
      throw new Error("Use a Notion HTTPS URL or a page/data-source ID.");
    candidate = u.pathname.split("/").filter(Boolean).at(-1) ?? "";
    const match = candidate.match(
      /([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i,
    );
    if (!match)
      throw new Error(
        "This Notion URL has no page or data-source ID. Paste the ID directly.",
      );
    candidate = match[1];
  }
  if (/^[a-f0-9]{32}$/i.test(candidate))
    candidate = candidate.replace(
      /^(.{8})(.{4})(.{4})(.{4})(.{12})$/,
      "$1-$2-$3-$4-$5",
    );
  const parsed = uuid.safeParse(candidate);
  if (!parsed.success)
    throw new Error("Enter a valid Notion page or data-source ID.");
  return parsed.data;
}
const reference = z
  .string()
  .min(1)
  .max(2000)
  .transform((v, c) => {
    try {
      return notionReference(v);
    } catch (e) {
      c.addIssue({
        code: "custom",
        message: e instanceof Error ? e.message : "Invalid reference",
      });
      return z.NEVER;
    }
  });
export const notionSelectionSchema = z
  .discriminatedUnion("action", [
    z
      .object({
        action: z.literal("page"),
        reference,
        readNested: z.boolean().default(false),
        allowContentRead: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("list"),
        reference,
        cursor: z.string().min(1).max(1000).nullable().default(null),
        allowMetadataRead: z.literal(true),
      })
      .strict(),
    z
      .object({
        action: z.literal("rows"),
        dataSourceId: uuid,
        pageIds: z.array(uuid).min(1).max(5),
        readNested: z.boolean().default(false),
        allowContentRead: z.literal(true),
      })
      .strict(),
  ])
  .superRefine((v, c) => {
    if (v.action === "rows" && new Set(v.pageIds).size !== v.pageIds.length)
      c.addIssue({ code: "custom", message: "Choose distinct rows." });
  });
export type NotionSelection = z.infer<typeof notionSelectionSchema>;
export interface NotionRows {
  dataSourceId: string;
  title: string;
  rows: { id: string; title: string; url: string | null; revision: string }[];
  nextCursor: string | null;
}
