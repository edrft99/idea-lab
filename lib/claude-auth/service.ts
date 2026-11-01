import { z } from "zod";
import { AppError } from "../ideas/errors";
import { digest } from "../ideas/operations";
import type { OperationalDB, Statement } from "../ideas/runtime";
import {
  CLAUDE_CLIENT,
  CLAUDE_REDIRECT,
  authorizeSchema,
  tokenSchema,
  requestRow,
  sessionRow,
  hashSchema,
  accessSeconds,
  sessionSeconds,
  type Actor,
  type AuthRequest,
} from "./model";
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const b64 = (a: Uint8Array) =>
  btoa(String.fromCharCode(...a))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
export const randomToken = () =>
  b64(crypto.getRandomValues(new Uint8Array(32)));
export const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
export async function challenge(verifier: string) {
  return b64(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}
export async function verifyClaudeClient(fetcher: typeof fetch = fetch) {
  const r = await fetcher(CLAUDE_CLIENT, {
    redirect: "manual",
    signal: AbortSignal.timeout(5000),
    headers: { Accept: "application/json" },
  });
  if (!r.ok || !r.headers.get("content-type")?.includes("application/json"))
    throw new AppError(
      "CLAUDE_CLIENT_UNAVAILABLE",
      "Claude’s published client metadata could not be verified. No access was granted.",
      503,
    );
  const reader = r.body?.getReader();
  if (!reader)
    throw new AppError(
      "CLAUDE_CLIENT_UNAVAILABLE",
      "Claude client metadata is unavailable.",
      503,
    );
  const parts: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 24000) {
      await reader.cancel();
      throw new AppError(
        "CLAUDE_CLIENT_UNAVAILABLE",
        "Claude client metadata exceeds the allowed size.",
        503,
      );
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  const text = new TextDecoder().decode(bytes);
  const c = z
    .object({
      redirect_uris: z.array(z.string().url()).min(1).max(20),
      token_endpoint_auth_method: z.literal("none").optional(),
      grant_types: z.array(z.string()).optional(),
    })
    .passthrough()
    .safeParse(JSON.parse(text));
  if (
    !c.success ||
    !c.data.redirect_uris.includes(CLAUDE_REDIRECT) ||
    (c.data.grant_types && !c.data.grant_types.includes("authorization_code"))
  )
    throw new AppError(
      "CLAUDE_CLIENT_UNAVAILABLE",
      "Claude’s published client metadata does not match the permitted callback.",
      503,
    );
}
export class ClaudeAuthService {
  readonly resource: string;
  constructor(
    private db: OperationalDB,
    readonly gatewayOrigin: string,
    readonly siteOrigin: string,
    private ownerAllowed: (actor: Actor) => boolean,
    private verifyClient: () => Promise<void> = () => verifyClaudeClient(),
  ) {
    for (const origin of [gatewayOrigin, siteOrigin]) {
      const u = new URL(origin);
      if (u.protocol !== "https:" || u.origin !== origin)
        throw new AppError(
          "CLAUDE_AUTH_CONFIGURATION",
          "Claude authentication origins must be exact HTTPS origins.",
          503,
        );
    }
    if (gatewayOrigin === siteOrigin)
      throw new AppError(
        "CLAUDE_AUTH_CONFIGURATION",
        "Claude requires a separate public OAuth relay origin.",
        503,
      );
    this.resource = gatewayOrigin + "/api/claude/mcp";
  }
  metadata() {
    return {
      issuer: this.gatewayOrigin,
      authorization_endpoint: this.gatewayOrigin + "/authorize",
      token_endpoint: this.gatewayOrigin + "/token",
      revocation_endpoint: this.gatewayOrigin + "/revoke",
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
      scopes_supported: ["ideas:read", "ideas:capture"],
    };
  }
  resourceMetadata() {
    return {
      resource: this.resource,
      authorization_servers: [this.gatewayOrigin],
      scopes_supported: ["ideas:read", "ideas:capture"],
      bearer_methods_supported: ["header"],
    };
  }
  private owner(actor: Actor) {
    if (!this.ownerAllowed(actor))
      throw new AppError(
        "FORBIDDEN",
        "This authorization belongs to another owner or the owner configuration changed.",
        403,
      );
  }
  private async batch(statements: Statement[]) {
    if (!this.db.batch)
      throw new AppError(
        "CLAUDE_AUTH_STORAGE",
        "Transactional authorization storage is unavailable.",
        503,
      );
    await this.db.batch(statements);
  }
  private async row(id: string) {
    const r = await this.db
      .prepare("SELECT * FROM idea_lab_claude_auth_requests WHERE id=?")
      .bind(hashSchema.parse(id))
      .first();
    if (!r)
      throw new AppError(
        "CLAUDE_AUTH_NOT_FOUND",
        "This connection request is unavailable.",
        404,
      );
    return requestRow.parse(r);
  }
  private reviewHash(row: AuthRequest, actor: Actor) {
    return digest(
      JSON.stringify({
        id: row.id,
        client: row.client_id,
        redirect: row.redirect_uri,
        challenge: row.code_challenge,
        state: row.state,
        scope: row.scope,
        resource: row.resource,
        expiresAt: row.expires_at,
        actor: actor.userId,
      }),
    );
  }
  async start(input: unknown) {
    const p = authorizeSchema.parse(input);
    if (p.resource !== this.resource)
      throw new AppError(
        "INVALID_RESOURCE",
        "This authorization is for a different MCP resource.",
        400,
      );
    let stage = "cleanup";
    try {
      const cutoff = Date.now() - 86400000;
      await this.db
        .prepare(
          "DELETE FROM idea_lab_claude_auth_requests WHERE id IN (SELECT id FROM idea_lab_claude_auth_requests WHERE expires_at<=? LIMIT 100)",
        )
        .bind(cutoff)
        .run();
      await this.db
        .prepare(
          "DELETE FROM idea_lab_claude_tokens WHERE session_id IN (SELECT id FROM idea_lab_claude_sessions WHERE expires_at<=? LIMIT 100)",
        )
        .bind(cutoff)
        .run();
      await this.db
        .prepare(
          "DELETE FROM idea_lab_claude_sessions WHERE id IN (SELECT id FROM idea_lab_claude_sessions WHERE expires_at<=? LIMIT 100)",
        )
        .bind(cutoff)
        .run();
      stage = "client_metadata";
      await this.verifyClient();
      stage = "request_storage";
      const now = Date.now(),
        id = randomId();
      const result = await this.db
        .prepare(
          "INSERT INTO idea_lab_claude_auth_requests (id,client_id,redirect_uri,code_challenge,state,scope,resource,status,created_at,expires_at) SELECT ?,?,?,?,?,?,?,'pending',?,? WHERE (SELECT COUNT(*) FROM idea_lab_claude_auth_requests WHERE expires_at>? AND status='pending')<50 AND (SELECT COUNT(*) FROM idea_lab_claude_auth_requests WHERE created_at>?)<500 RETURNING id",
        )
        .bind(
          id,
          p.client_id,
          p.redirect_uri,
          p.code_challenge,
          p.state,
          p.scope,
          p.resource,
          now,
          now + 300000,
          now,
          now - 86400000,
        )
        .first();
      if (!result)
        throw new AppError(
          "CLAUDE_AUTH_RATE_LIMIT",
          "Too many connection requests. Try again later.",
          429,
          60,
        );
      return {
        requestId: id,
        consentUrl: this.siteOrigin + "/claude/connect/" + id,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message.toLowerCase() : "";
      const reasons = [
        "redirect",
        "fetch",
        "json",
        "d1_",
        "sqlite",
        "timeout",
        "abort",
        "illegal invocation",
        "not a function",
      ] as const;
      console.error(
        JSON.stringify({
          event: "claude_authorization_failed",
          stage,
          code: error instanceof AppError ? error.code : "UNAVAILABLE",
          reason:
            reasons.find((reason) => message.includes(reason)) ?? "unknown",
        }),
      );
      throw error;
    }
  }
  async review(id: string, actor: Actor) {
    this.owner(actor);
    const r = await this.row(id);
    return {
      requestId: r.id,
      clientName: "Claude",
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      resource: r.resource,
      scopes: r.scope.split(" "),
      expiresAt: new Date(r.expires_at).toISOString(),
      status: r.status,
      canApprove: r.status === "pending" && r.expires_at > Date.now(),
      reviewHash: await this.reviewHash(r, actor),
    };
  }
  async decide(
    id: string,
    decision: "approve" | "deny",
    reviewHash: string,
    actor: Actor,
  ) {
    this.owner(actor);
    const r = await this.row(id);
    if (r.expires_at <= Date.now() || r.status !== "pending")
      throw new AppError(
        "CLAUDE_AUTH_EXPIRED",
        "This connection review expired or was already used. Start a new connection from Claude.",
        409,
      );
    if (reviewHash !== (await this.reviewHash(r, actor)))
      throw new AppError(
        "CLAUDE_AUTH_REVIEW_CHANGED",
        "Review this exact connection request again.",
        409,
      );
    const code = decision === "approve" ? randomToken() : null,
      now = Date.now();
    const changed = await this.db
      .prepare(
        "UPDATE idea_lab_claude_auth_requests SET status=?,actor_id=?,actor_email=?,code_hash=?,code_expires_at=?,approved_at=? WHERE id=? AND status='pending' AND expires_at>? AND (?='denied' OR (SELECT COUNT(*) FROM idea_lab_claude_sessions WHERE actor_id=? AND revoked_at IS NULL AND expires_at>?)<20) RETURNING id",
      )
      .bind(
        decision === "approve" ? "approved" : "denied",
        actor.userId,
        actor.email.toLowerCase(),
        code ? await digest(code) : null,
        code ? Math.min(now + 60000, r.expires_at) : null,
        now,
        id,
        now,
        decision === "approve" ? "approved" : "denied",
        actor.userId,
        now,
      )
      .first();
    if (!changed)
      throw new AppError(
        "CLAUDE_AUTH_CHANGED",
        "This connection request changed or the active connection limit was reached.",
        409,
      );
    const redirect = new URL(CLAUDE_REDIRECT);
    redirect.searchParams.set("state", r.state);
    redirect.searchParams.set("iss", this.gatewayOrigin);
    if (code) redirect.searchParams.set("code", code);
    else redirect.searchParams.set("error", "access_denied");
    return { redirectUrl: redirect.href };
  }
  private credentials() {
    return {
      access: randomToken(),
      refresh: randomToken(),
      id: randomId(),
      claim: randomId(),
      now: Date.now(),
    };
  }
  private async response(access: string, refresh: string, scope: string) {
    return {
      access_token: access,
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: accessSeconds,
      scope,
    };
  }
  async exchange(input: unknown) {
    const p = tokenSchema.parse(input);
    if (p.resource && p.resource !== this.resource)
      throw new AppError(
        "INVALID_RESOURCE",
        "This token request targets a different resource.",
        400,
      );
    return p.grant_type === "authorization_code"
      ? this.code(p)
      : this.refresh(p);
  }
  private async code(
    p: Extract<
      z.infer<typeof tokenSchema>,
      { grant_type: "authorization_code" }
    >,
  ) {
    const row = await this.db
      .prepare("SELECT * FROM idea_lab_claude_auth_requests WHERE code_hash=?")
      .bind(await digest(p.code))
      .first();
    const parsed = requestRow.safeParse(row);
    if (!parsed.success)
      throw new AppError(
        "INVALID_GRANT",
        "This authorization code is invalid or expired.",
        400,
      );
    const r = parsed.data;
    if (
      r.status !== "approved" ||
      !r.actor_id ||
      !r.actor_email ||
      !r.code_expires_at ||
      r.code_expires_at <= Date.now() ||
      r.redirect_uri !== p.redirect_uri ||
      r.client_id !== p.client_id ||
      r.resource !== this.resource ||
      r.code_challenge !== (await challenge(p.code_verifier))
    )
      throw new AppError(
        "INVALID_GRANT",
        "This authorization code, client or proof key is invalid or expired.",
        400,
      );
    this.owner({ userId: r.actor_id, email: r.actor_email });
    const c = this.credentials();
    await this.batch([
      this.db
        .prepare(
          "UPDATE idea_lab_claude_auth_requests SET status='used',claimed_by=? WHERE id=? AND status='approved' AND code_expires_at>? AND claimed_by IS NULL AND (SELECT COUNT(*) FROM idea_lab_claude_sessions s WHERE s.actor_id=idea_lab_claude_auth_requests.actor_id AND s.revoked_at IS NULL AND s.expires_at>?)<20",
        )
        .bind(c.claim, r.id, c.now, c.now),
      this.db
        .prepare(
          "INSERT INTO idea_lab_claude_sessions (id,actor_id,actor_email,client_id,resource,scope,created_at,expires_at) SELECT ?,actor_id,actor_email,client_id,resource,scope,?,? FROM idea_lab_claude_auth_requests WHERE id=? AND claimed_by=?",
        )
        .bind(c.id, c.now, c.now + sessionSeconds * 1000, r.id, c.claim),
      this.db
        .prepare(
          "INSERT INTO idea_lab_claude_tokens (access_hash,refresh_hash,session_id,created_at,expires_at) SELECT ?,?,id,?,? FROM idea_lab_claude_sessions WHERE id=?",
        )
        .bind(
          await digest(c.access),
          await digest(c.refresh),
          c.now,
          c.now + accessSeconds * 1000,
          c.id,
        ),
    ]);
    if (
      !(await this.db
        .prepare(
          "SELECT access_hash FROM idea_lab_claude_tokens WHERE access_hash=?",
        )
        .bind(await digest(c.access))
        .first())
    )
      throw new AppError(
        "INVALID_GRANT",
        "This authorization code was already used.",
        400,
      );
    return this.response(c.access, c.refresh, r.scope);
  }
  private async refresh(
    p: Extract<z.infer<typeof tokenSchema>, { grant_type: "refresh_token" }>,
  ) {
    const old = await this.db
      .prepare(
        "SELECT t.*,s.actor_id,s.actor_email,s.client_id,s.resource,s.scope,s.revoked_at,s.expires_at AS session_expires_at FROM idea_lab_claude_tokens t JOIN idea_lab_claude_sessions s ON s.id=t.session_id WHERE t.refresh_hash=?",
      )
      .bind(await digest(p.refresh_token))
      .first<Record<string, unknown>>();
    if (
      !old ||
      old.client_id !== p.client_id ||
      old.resource !== this.resource ||
      old.revoked_at !== null ||
      typeof old.session_expires_at !== "number" ||
      old.session_expires_at <= Date.now()
    )
      throw new AppError(
        "INVALID_GRANT",
        "This refresh grant is invalid or expired. Connect Claude again.",
        400,
      );
    this.owner({
      userId: z.string().parse(old.actor_id),
      email: z.string().parse(old.actor_email),
    });
    if (old.rotated_by !== null) {
      await this.revokeSession(z.string().parse(old.session_id));
      throw new AppError(
        "REFRESH_REUSED",
        "A refresh token was reused. This connection was revoked; connect Claude again.",
        400,
      );
    }
    const c = this.credentials();
    await this.batch([
      this.db
        .prepare(
          "UPDATE idea_lab_claude_tokens SET rotated_by=? WHERE refresh_hash=? AND rotated_by IS NULL AND EXISTS(SELECT 1 FROM idea_lab_claude_sessions WHERE id=session_id AND revoked_at IS NULL AND expires_at>?)",
        )
        .bind(c.claim, await digest(p.refresh_token), c.now),
      this.db
        .prepare(
          "INSERT INTO idea_lab_claude_tokens (access_hash,refresh_hash,session_id,created_at,expires_at) SELECT ?,?,session_id,?,? FROM idea_lab_claude_tokens WHERE refresh_hash=? AND rotated_by=? AND EXISTS(SELECT 1 FROM idea_lab_claude_sessions WHERE id=session_id AND revoked_at IS NULL AND expires_at>?)",
        )
        .bind(
          await digest(c.access),
          await digest(c.refresh),
          c.now,
          c.now + accessSeconds * 1000,
          await digest(p.refresh_token),
          c.claim,
          c.now,
        ),
    ]);
    if (
      !(await this.db
        .prepare(
          "SELECT access_hash FROM idea_lab_claude_tokens WHERE access_hash=?",
        )
        .bind(await digest(c.access))
        .first())
    ) {
      await this.revokeSession(z.string().parse(old.session_id));
      throw new AppError(
        "REFRESH_REUSED",
        "The refresh grant was already used. Connect Claude again.",
        400,
      );
    }
    return this.response(c.access, c.refresh, z.string().parse(old.scope));
  }
  async authenticate(token: string, scope?: "ideas:read" | "ideas:capture") {
    if (!tokenPattern.test(token))
      throw new AppError(
        "INVALID_TOKEN",
        "Connect Claude to Idea Lab first.",
        401,
      );
    const row = await this.db
      .prepare(
        "SELECT s.* FROM idea_lab_claude_tokens t JOIN idea_lab_claude_sessions s ON s.id=t.session_id WHERE t.access_hash=? AND t.expires_at>? AND s.expires_at>? AND s.revoked_at IS NULL",
      )
      .bind(await digest(token), Date.now(), Date.now())
      .first();
    const parsed = sessionRow.safeParse(row);
    if (!parsed.success || parsed.data.resource !== this.resource)
      throw new AppError(
        "INVALID_TOKEN",
        "The Claude connection expired or was revoked. Connect again.",
        401,
      );
    const s = parsed.data;
    this.owner({ userId: s.actor_id, email: s.actor_email });
    if (scope && !s.scope.split(" ").includes(scope))
      throw new AppError(
        "INSUFFICIENT_SCOPE",
        "This Claude connection does not have permission for this tool.",
        403,
      );
    return {
      userId: s.actor_id,
      email: s.actor_email,
      sessionId: s.id,
      scope: s.scope,
    };
  }
  private async revokeSession(id: string) {
    await this.db
      .prepare(
        "UPDATE idea_lab_claude_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=?",
      )
      .bind(Date.now(), id)
      .run();
  }
  async revokeToken(token: string, client: string) {
    if (client !== CLAUDE_CLIENT || !tokenPattern.test(token)) return;
    const r = await this.db
      .prepare(
        "SELECT t.session_id FROM idea_lab_claude_tokens t JOIN idea_lab_claude_sessions s ON s.id=t.session_id WHERE (t.access_hash=? OR t.refresh_hash=?) AND s.client_id=?",
      )
      .bind(await digest(token), await digest(token), client)
      .first<{ session_id: string }>();
    if (r) await this.revokeSession(r.session_id);
  }
  async sessions(actor: Actor) {
    this.owner(actor);
    const rows = await this.db
      .prepare(
        "SELECT * FROM idea_lab_claude_sessions WHERE actor_id=? ORDER BY (revoked_at IS NULL AND expires_at>?) DESC,created_at DESC LIMIT 40",
      )
      .bind(actor.userId, Date.now())
      .all();
    return rows.results.map((r) => {
      const s = sessionRow.parse(r);
      return {
        id: s.id,
        scopes: s.scope.split(" "),
        createdAt: new Date(s.created_at).toISOString(),
        expiresAt: new Date(s.expires_at).toISOString(),
        revoked: s.revoked_at !== null,
        expired: s.expires_at <= Date.now(),
      };
    });
  }
  async revokeOwned(id: string, actor: Actor) {
    this.owner(actor);
    await this.db
      .prepare(
        "UPDATE idea_lab_claude_sessions SET revoked_at=COALESCE(revoked_at,?) WHERE id=? AND actor_id=?",
      )
      .bind(Date.now(), hashSchema.parse(id), actor.userId)
      .run();
  }
}
