import { z } from "zod";
export const CLAUDE_CLIENT =
  "https://claude.ai/oauth/mcp-oauth-client-metadata";
export const CLAUDE_REDIRECT = "https://claude.ai/api/mcp/auth_callback";
export const scopeValues = ["ideas:read", "ideas:capture"] as const;
export const scopeSchema = z
  .string()
  .max(100)
  .transform((s) => [...new Set(s.split(" ").filter(Boolean))].sort())
  .refine(
    (s) =>
      s.length > 0 &&
      s.every((v) => scopeValues.includes(v as (typeof scopeValues)[number])),
    "Unsupported scope",
  )
  .transform((s) => s.join(" "));
export const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const authorizeSchema = z
  .object({
    response_type: z.literal("code"),
    client_id: z.literal(CLAUDE_CLIENT),
    redirect_uri: z.literal(CLAUDE_REDIRECT),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
    state: z.string().min(8).max(2000),
    scope: scopeSchema.default("ideas:read ideas:capture"),
    resource: z.string().url(),
  })
  .strict();
export const tokenSchema = z.discriminatedUnion("grant_type", [
  z
    .object({
      grant_type: z.literal("authorization_code"),
      client_id: z.literal(CLAUDE_CLIENT),
      code: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      redirect_uri: z.literal(CLAUDE_REDIRECT),
      code_verifier: z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/),
      resource: z.string().url().optional(),
    })
    .strict(),
  z
    .object({
      grant_type: z.literal("refresh_token"),
      client_id: z.literal(CLAUDE_CLIENT),
      refresh_token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
      resource: z.string().url().optional(),
    })
    .strict(),
]);
export const decisionSchema = z
  .object({
    requestId: hashSchema,
    decision: z.enum(["approve", "deny"]),
    reviewHash: hashSchema,
  })
  .strict();
export const requestRow = z.object({
  id: hashSchema,
  client_id: z.literal(CLAUDE_CLIENT),
  redirect_uri: z.literal(CLAUDE_REDIRECT),
  code_challenge: z.string(),
  state: z.string(),
  scope: scopeSchema,
  resource: z.string(),
  status: z.enum(["pending", "approved", "denied", "used"]),
  actor_id: z.string().nullable(),
  actor_email: z.string().nullable(),
  code_hash: z.string().nullable(),
  code_expires_at: z.number().nullable(),
  claimed_by: z.string().nullable(),
  created_at: z.number(),
  expires_at: z.number(),
  approved_at: z.number().nullable(),
});
export type AuthRequest = z.infer<typeof requestRow>;
export type Actor = { userId: string; email: string };
export const sessionRow = z.object({
  id: hashSchema,
  actor_id: z.string(),
  actor_email: z.string(),
  client_id: z.literal(CLAUDE_CLIENT),
  resource: z.string(),
  scope: scopeSchema,
  created_at: z.number(),
  expires_at: z.number(),
  revoked_at: z.number().nullable(),
});
export type Session = z.infer<typeof sessionRow>;
export const accessSeconds = 900,
  sessionSeconds = 30 * 24 * 3600;
