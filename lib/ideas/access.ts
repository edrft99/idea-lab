import { IdeaDeletion } from "./deletion";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { AppError } from "./errors";
import { envValue, notionConfig, operationalDB } from "./runtime";
import { NotionRepository } from "./notion";
import { Operations } from "./operations";
import { IdeaService } from "./service";
export async function authorizeOwner() {
  const user = await getChatGPTUser();
  if (!user)
    throw new AppError(
      "UNAUTHENTICATED",
      "Sign in to access this workspace.",
      401,
    );
  const ownerId = envValue("IDEA_LAB_OWNER_USER_ID"),
    ownerEmail = envValue("IDEA_LAB_OWNER_EMAIL")?.toLowerCase();
  if (!ownerId && !ownerEmail)
    throw new AppError(
      "OWNER_CONFIGURATION_REQUIRED",
      "Configure the Site owner before accessing the shared Notion connection.",
    );
  if (
    ownerId
      ? user.userId !== ownerId
      : user.email.trim().toLowerCase() !== ownerEmail
  )
    throw new AppError(
      "FORBIDDEN",
      "This workspace belongs to another user.",
      403,
    );
  return user;
}
export function repository() {
  return new NotionRepository(notionConfig());
}
export function writeService() {
  return new IdeaService(repository(), new Operations(operationalDB()));
}
export function checkOrigin(request: Request) {
  const expected =
    envValue("IDEA_LAB_SITE_ORIGIN") ?? new URL(request.url).origin;
  const origin = request.headers.get("Origin");
  if (
    !origin ||
    origin !== expected ||
    request.headers.get("Sec-Fetch-Site") === "cross-site"
  )
    throw new AppError(
      "INVALID_ORIGIN",
      "This action must be submitted from the Idea Lab website.",
      403,
    );
}
export async function jsonBody(
  request: Request,
  maximum = 24000,
): Promise<unknown> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json"))
    throw new AppError(
      "INVALID_CONTENT_TYPE",
      "Submit JSON from the Idea Lab form.",
      415,
    );
  const declared = Number(request.headers.get("Content-Length"));
  if (declared > maximum)
    throw new AppError(
      "PAYLOAD_TOO_LARGE",
      "The idea is too long for this form.",
      413,
    );
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError("INVALID_BODY", "The request body is missing.", 400);
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel();
      throw new AppError(
        "PAYLOAD_TOO_LARGE",
        "The idea is too long for this form.",
        413,
      );
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AppError("INVALID_BODY", "The JSON body is invalid.", 400);
  }
}

export function deletionService() {
  return new IdeaDeletion(repository(), new Operations(operationalDB()));
}
