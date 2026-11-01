import { AppError } from "../ideas/errors";
import { envValue, operationalDB } from "../ideas/runtime";
import { digest } from "../ideas/operations";
import { ClaudeAuthService } from "./service";
export function claudeAuthService(siteOrigin: string) {
  const origin = envValue("IDEA_LAB_CLAUDE_ORIGIN");
  if (!origin)
    throw new AppError(
      "CLAUDE_AUTH_CONFIGURATION",
      "Claude sign-in is not configured yet.",
      503,
    );
  return new ClaudeAuthService(
    operationalDB(),
    origin,
    envValue("IDEA_LAB_SITE_ORIGIN") ?? siteOrigin,
    (actor) => {
      const id = envValue("IDEA_LAB_OWNER_USER_ID"),
        email = envValue("IDEA_LAB_OWNER_EMAIL")?.toLowerCase();
      return Boolean(
        id ? actor.userId === id : email && actor.email.toLowerCase() === email,
      );
    },
  );
}
export async function requireRelay(request: Request) {
  const expected = envValue("IDEA_LAB_CLAUDE_RELAY_KEY"),
    provided = request.headers.get("X-Idea-Lab-Relay-Key");
  if (!expected || expected.length < 43)
    throw new AppError(
      "CLAUDE_AUTH_CONFIGURATION",
      "Claude relay access is not configured.",
      503,
    );
  if (!provided || provided.length > 128)
    throw new AppError(
      "UNAUTHORIZED_RELAY",
      "This endpoint requires the configured Claude relay.",
      401,
    );
  const a = await digest(expected),
    b = await digest(provided);
  let difference = 0;
  for (let i = 0; i < a.length; i++)
    difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  if (difference !== 0)
    throw new AppError(
      "UNAUTHORIZED_RELAY",
      "This endpoint requires the configured Claude relay.",
      401,
    );
}
export function bearer(request: Request) {
  const value = request.headers.get("X-Idea-Lab-Claude-Authorization");
  const match = value?.match(/^Bearer ([A-Za-z0-9_-]{43})$/i);
  if (!match)
    throw new AppError(
      "INVALID_TOKEN",
      "Connect Claude to Idea Lab first.",
      401,
    );
  return match[1];
}
export function parameters(params: URLSearchParams) {
  const result: Record<string, string> = {};
  for (const [k, v] of params) {
    if (Object.hasOwn(result, k))
      throw new AppError(
        "INVALID_REQUEST",
        "Repeated OAuth parameters are not accepted.",
        400,
      );
    result[k] = v;
  }
  return result;
}
export async function oauthForm(request: Request) {
  if (
    !request.headers
      .get("Content-Type")
      ?.startsWith("application/x-www-form-urlencoded")
  )
    throw new AppError("INVALID_REQUEST", "Use an OAuth form request.", 400);
  const reader = request.body?.getReader();
  if (!reader)
    throw new AppError(
      "INVALID_REQUEST",
      "The OAuth request body is missing.",
      400,
    );
  let total = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > 12000) {
      await reader.cancel();
      throw new AppError(
        "INVALID_REQUEST",
        "The OAuth request is too large.",
        413,
      );
    }
    chunks.push(value);
  }
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    raw.set(c, offset);
    offset += c.length;
  }
  return parameters(new URLSearchParams(new TextDecoder().decode(raw)));
}
