import { z } from "zod";
import { uuid } from "../ideas/domain";
import { AppError } from "../ideas/errors";

export const MAX_FILE_BYTES = 5 * 1024 * 1024;
export const fileTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/plain",
  csv: "text/csv",
  json: "application/json",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const fileAccept = Object.keys(fileTypes)
  .map((x) => "." + x)
  .join(",");
export const metadataSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .max(180)
      .refine(
        (n) => !/[\\/\x00-\x1f\x7f]/.test(n) && n.trim() === n,
        "Use a plain filename without paths or control characters.",
      ),
    size: z.number().int().min(1).max(MAX_FILE_BYTES),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type FileMetadata = z.infer<typeof metadataSchema>;
export const prepareSchema = z
  .object({ ideaId: uuid, file: metadataSchema })
  .strict();
export function contentType(name: string) {
  const type = fileTypes[name.split(".").pop()?.toLowerCase() ?? ""];
  if (!type)
    throw new AppError(
      "FILE_TYPE_UNSUPPORTED",
      "Choose an image, PDF, text, JSON, ZIP or Office document from the supported file types.",
      400,
    );
  return type;
}
export function imageType(name: string) {
  return contentType(name).startsWith("image/");
}
export async function fileDigest(bytes: ArrayBuffer): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function inspectFile(file: File): Promise<FileMetadata> {
  if (!file.size || file.size > MAX_FILE_BYTES)
    throw new AppError(
      "FILE_SIZE_INVALID",
      "Choose a nonempty file no larger than 5 MB.",
      400,
    );
  contentType(file.name);
  const parsed = metadataSchema.safeParse({
    name: file.name,
    size: file.size,
    sha256: await fileDigest(await file.arrayBuffer()),
  });
  if (!parsed.success)
    throw new AppError(
      "FILE_INVALID",
      "Use a plain filename of at most 180 characters.",
      400,
    );
  return parsed.data;
}
export function verifyImageSignature(name: string, bytes: Uint8Array) {
  const type = contentType(name),
    start = Array.from(bytes.slice(0, 12));
  const matches =
    type === "image/png"
      ? [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => start[i] === b)
      : type === "image/jpeg"
        ? start[0] === 255 && start[1] === 216 && start[2] === 255
        : type === "image/gif"
          ? /^GIF8[79]a/.test(new TextDecoder().decode(bytes.slice(0, 6)))
          : type === "image/webp"
            ? new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
              new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP"
            : true;
  if (!matches)
    throw new AppError(
      "IMAGE_INVALID",
      "The image content does not match its filename. Choose a valid PNG, JPEG, GIF or WebP image.",
      400,
    );
}
export interface Attachment {
  id: string;
  name: string;
  kind: "image" | "file";
  url: string;
  expiresAt: string | null;
}
