import { z } from "zod";
import { uuid, filtersSchema, type Idea } from "../ideas/domain";
import { digest } from "../ideas/operations";
import { redact } from "../imports/staging";
export const semanticFields = [
  "title",
  "summary",
  "problem",
  "solution",
  "audience",
  "expectedValue",
  "context",
] as const;
export const inputVersion = "semantic-fields-v1";
export const fieldsSchema = z
  .array(z.enum(semanticFields))
  .min(1)
  .max(7)
  .refine((v) => new Set(v).size === v.length, "Choose each field once.")
  .transform((v) => semanticFields.filter((k) => v.includes(k)));
export const indexCommandSchema = z
  .object({
    records: z
      .array(
        z
          .object({ id: uuid, expectedRevision: z.string().min(1).max(300) })
          .strict(),
      )
      .min(1)
      .max(20),
    fields: fieldsSchema,
    refresh: z.boolean().default(false),
  })
  .strict()
  .refine(
    (v) => new Set(v.records.map((r) => r.id)).size === v.records.length,
    "Choose each idea once.",
  );
export type IndexCommand = z.infer<typeof indexCommandSchema>;
export const semanticFiltersSchema = filtersSchema
  .omit({ query: true, sort: true })
  .strict();
export const queryCommandSchema = z
  .object({
    query: z.string().trim().min(1).max(2000),
    filters: semanticFiltersSchema,
    limit: z.number().int().min(1).max(20),
    threshold: z.number().finite().min(-1).max(1),
  })
  .strict();
export type QueryCommand = z.infer<typeof queryCommandSchema>;
export const clearCommandSchema = z
  .object({ scope: z.literal("all-my-semantic-vectors") })
  .strict();
export function clipUTF8(text: string, maximum = 760) {
  let result = "",
    size = 0;
  for (const char of text) {
    const n = new TextEncoder().encode(char).byteLength;
    if (size + n > maximum) break;
    result += char;
    size += n;
  }
  return result;
}
function boundedExcerpt(text: string) {
  let result = "",
    bytes = 0;
  for (const char of text) {
    const size = new TextEncoder().encode(JSON.stringify(char)).byteLength - 2;
    if (bytes + size > 760) break;
    result += char;
    bytes += size;
  }
  return result;
}
export async function semanticInput(
  idea: Idea,
  fields: z.infer<typeof fieldsSchema>,
  secrets: string[] = [],
) {
  const selected = Object.fromEntries(
    fields.map((k) => [k, redact(idea[k], secrets)]),
  );
  if (!Object.values(selected).some((v) => v.trim()))
    throw new Error("No selected description is available.");
  const input = JSON.stringify(
      Object.fromEntries(fields.map((k) => [k, boundedExcerpt(selected[k])])),
    ),
    hash = await digest(JSON.stringify([inputVersion, selected]));
  return { input, hash, fields };
}
export function unitVector(values: number[], dimensions: number) {
  if (values.length !== dimensions || values.some((n) => !Number.isFinite(n)))
    throw new Error("Invalid vector dimensions or values.");
  const norm = Math.hypot(...values);
  if (!Number.isFinite(norm) || norm <= 0)
    throw new Error("Invalid vector norm.");
  return values.map((v) => v / norm);
}
export function cosine(a: number[], b: number[]) {
  if (a.length !== b.length) throw new Error("Incompatible vector dimensions.");
  return Math.max(
    -1,
    Math.min(
      1,
      a.reduce((sum, n, i) => sum + n * b[i], 0),
    ),
  );
}
