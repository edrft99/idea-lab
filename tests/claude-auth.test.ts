import { describe, it, expect, vi, afterEach } from "vitest";
import { memoryDB } from "./fixtures";
import {
  ClaudeAuthService,
  challenge,
  verifyClaudeClient,
} from "../lib/claude-auth/service";
import { CLAUDE_CLIENT, CLAUDE_REDIRECT } from "../lib/claude-auth/model";
const actor = { userId: "owner", email: "owner@example.test" },
  verifier = "a".repeat(64),
  gateway = "https://claude-gateway.test",
  site = "https://idea.test";
function setup() {
  const memory = memoryDB(),
    client = vi.fn(async () => {}),
    service = new ClaudeAuthService(
      memory.db,
      gateway,
      site,
      (a) => a.userId === "owner",
      client,
    );
  return { memory, client, service };
}
async function pending(
  s: ReturnType<typeof setup>,
  extra: Record<string, unknown> = {},
) {
  return s.service.start({
    response_type: "code",
    client_id: CLAUDE_CLIENT,
    redirect_uri: CLAUDE_REDIRECT,
    code_challenge: await challenge(verifier),
    code_challenge_method: "S256",
    state: "synthetic-state-123",
    scope: "ideas:read ideas:capture",
    resource: gateway + "/api/claude/mcp",
    ...extra,
  });
}
async function approved(
  s: ReturnType<typeof setup>,
  extra: Record<string, unknown> = {},
) {
  const p = await pending(s, extra),
    view = await s.service.review(p.requestId, actor),
    result = await s.service.decide(
      p.requestId,
      "approve",
      view.reviewHash,
      actor,
    );
  return {
    p,
    view,
    code: new URL(result.redirectUrl).searchParams.get("code")!,
    redirect: new URL(result.redirectUrl),
  };
}
async function connect(
  s: ReturnType<typeof setup>,
  extra: Record<string, unknown> = {},
) {
  const a = await approved(s, extra),
    tokens = await s.service.exchange({
      grant_type: "authorization_code",
      client_id: CLAUDE_CLIENT,
      code: a.code,
      redirect_uri: CLAUDE_REDIRECT,
      code_verifier: verifier,
      resource: gateway + "/api/claude/mcp",
    });
  return { ...a, tokens };
}
afterEach(() => vi.restoreAllMocks());
describe("Claude scoped OAuth grants", () => {
  it("advertises CIMD, PKCE, revocation and the separate exact resource", () => {
    const s = setup();
    try {
      expect(s.service.metadata()).toMatchObject({
        client_id_metadata_document_supported: true,
        token_endpoint_auth_methods_supported: ["none"],
        code_challenge_methods_supported: ["S256"],
      });
      expect(s.service.resourceMetadata().resource).toBe(
        gateway + "/api/claude/mcp",
      );
    } finally {
      s.memory.close();
    }
  });
  it("requires owner consent before creating a grant and binds the callback/state/proof key", async () => {
    const s = setup();
    try {
      const p = await pending(s),
        r = await s.service.review(p.requestId, actor);
      expect(r.canApprove).toBe(true);
      expect(await s.service.sessions(actor)).toHaveLength(0);
      await expect(
        s.service.decide(p.requestId, "approve", "b".repeat(64), actor),
      ).rejects.toMatchObject({ code: "CLAUDE_AUTH_REVIEW_CHANGED" });
      await expect(
        s.service.review(p.requestId, { ...actor, userId: "other" }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const result = await s.service.decide(
          p.requestId,
          "approve",
          r.reviewHash,
          actor,
        ),
        redirect = new URL(result.redirectUrl);
      expect(redirect.origin + redirect.pathname).toBe(CLAUDE_REDIRECT);
      expect(redirect.searchParams.get("state")).toBe("synthetic-state-123");
      expect(redirect.searchParams.get("iss")).toBe(gateway);
      await expect(
        s.service.decide(p.requestId, "approve", r.reviewHash, actor),
      ).rejects.toMatchObject({ code: "CLAUDE_AUTH_EXPIRED" });
    } finally {
      s.memory.close();
    }
  });
  it("issues hashed short-lived access and rotating refresh credentials only after PKCE verification", async () => {
    const s = setup();
    try {
      const c = await connect(s);
      expect(c.tokens.expires_in).toBe(900);
      const user = await s.service.authenticate(
        c.tokens.access_token,
        "ideas:capture",
      );
      expect(user.userId).toBe("owner");
      const raw = JSON.stringify(
        (
          await s.memory.db
            .prepare("SELECT * FROM idea_lab_claude_tokens")
            .all()
        ).results,
      );
      expect(raw).not.toContain(c.tokens.access_token);
      expect(raw).not.toContain(c.tokens.refresh_token);
      expect(
        JSON.stringify(
          (
            await s.memory.db
              .prepare("SELECT * FROM idea_lab_claude_auth_requests")
              .all()
          ).results,
        ),
      ).not.toContain(c.code);
      await expect(
        s.service.exchange({
          grant_type: "authorization_code",
          client_id: CLAUDE_CLIENT,
          code: c.code,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: verifier,
        }),
      ).rejects.toMatchObject({ code: "INVALID_GRANT" });
      const next = await s.service.exchange({
        grant_type: "refresh_token",
        client_id: CLAUDE_CLIENT,
        refresh_token: c.tokens.refresh_token,
      });
      expect(next.access_token).not.toBe(c.tokens.access_token);
      expect((await s.service.authenticate(next.access_token)).userId).toBe(
        "owner",
      );
      await expect(
        s.service.exchange({
          grant_type: "refresh_token",
          client_id: CLAUDE_CLIENT,
          refresh_token: c.tokens.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "REFRESH_REUSED" });
      await expect(
        s.service.authenticate(next.access_token),
      ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    } finally {
      s.memory.close();
    }
  });
  it("refuses wrong proof keys, altered resources, redirect injection and unknown clients", async () => {
    const s = setup();
    try {
      for (const patch of [
        { redirect_uri: "https://evil.test/callback" },
        { client_id: "https://evil.test/client.json" },
        { resource: "https://evil.test/mcp" },
        { code_challenge_method: "plain" },
        { scope: "admin" },
        { approved: true },
      ])
        await expect(pending(s, patch)).rejects.toThrow();
      const a = await approved(s);
      await expect(
        s.service.exchange({
          grant_type: "authorization_code",
          client_id: CLAUDE_CLIENT,
          code: a.code,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: "b".repeat(64),
        }),
      ).rejects.toMatchObject({ code: "INVALID_GRANT" });
      expect(await s.service.sessions(actor)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("supports denial without any token or session", async () => {
    const s = setup();
    try {
      const p = await pending(s),
        v = await s.service.review(p.requestId, actor),
        result = await s.service.decide(
          p.requestId,
          "deny",
          v.reviewHash,
          actor,
        );
      expect(new URL(result.redirectUrl).searchParams.get("error")).toBe(
        "access_denied",
      );
      expect(new URL(result.redirectUrl).searchParams.has("code")).toBe(false);
      expect(await s.service.sessions(actor)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("rejects expired consent, expired codes and expired access tokens", async () => {
    const s = setup();
    try {
      const p = await pending(s);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 300001);
      expect((await s.service.review(p.requestId, actor)).canApprove).toBe(
        false,
      );
      vi.restoreAllMocks();
      const a = await approved(s);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 60001);
      await expect(
        s.service.exchange({
          grant_type: "authorization_code",
          client_id: CLAUDE_CLIENT,
          code: a.code,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: verifier,
        }),
      ).rejects.toMatchObject({ code: "INVALID_GRANT" });
      vi.restoreAllMocks();
      const c = await connect(s);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 900001);
      await expect(
        s.service.authenticate(c.tokens.access_token),
      ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    } finally {
      s.memory.close();
    }
  });
  it("enforces read-only scope and revokes both access and refresh grants", async () => {
    const s = setup();
    try {
      const c = await connect(s, { scope: "ideas:read" });
      await s.service.authenticate(c.tokens.access_token, "ideas:read");
      await expect(
        s.service.authenticate(c.tokens.access_token, "ideas:capture"),
      ).rejects.toMatchObject({ code: "INSUFFICIENT_SCOPE" });
      await s.service.revokeOwned(
        (await s.service.sessions(actor))[0].id,
        actor,
      );
      await expect(
        s.service.authenticate(c.tokens.access_token),
      ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
      await expect(
        s.service.exchange({
          grant_type: "refresh_token",
          client_id: CLAUDE_CLIENT,
          refresh_token: c.tokens.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    } finally {
      s.memory.close();
    }
  });
  it("enforces current owner authorization after token issuance", async () => {
    const s = setup();
    try {
      const c = await connect(s),
        changedOwner = new ClaudeAuthService(
          s.memory.db,
          gateway,
          site,
          () => false,
          s.client,
        );
      await expect(
        changedOwner.authenticate(c.tokens.access_token),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    } finally {
      s.memory.close();
    }
  });
  it("supports idempotent revocation and hides unknown tokens", async () => {
    const s = setup();
    try {
      const c = await connect(s);
      await s.service.revokeToken(c.tokens.access_token, CLAUDE_CLIENT);
      await s.service.revokeToken(c.tokens.access_token, CLAUDE_CLIENT);
      await s.service.revokeToken("x".repeat(43), CLAUDE_CLIENT);
      expect((await s.service.sessions(actor))[0].revoked).toBe(true);
    } finally {
      s.memory.close();
    }
  });
  it("fails closed when the provider client metadata cannot be verified", async () => {
    const s = setup();
    try {
      s.client.mockRejectedValueOnce(new Error("Synthetic provider failure"));
      await expect(pending(s)).rejects.toThrow();
      expect(await s.service.sessions(actor)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("uses Worker-compatible manual redirects and rejects redirected client metadata", async () => {
    const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
      expect(args[1]?.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://evil.test/client.json" },
      });
    });
    await expect(verifyClaudeClient(f)).rejects.toMatchObject({
      code: "CLAUDE_CLIENT_UNAVAILABLE",
    });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("verifies only the pinned published Claude identity and callback", async () => {
    const f = vi.fn(async (..._args: Parameters<typeof fetch>) =>
      Response.json({
        client_name: "Claude",
        redirect_uris: [CLAUDE_REDIRECT],
        token_endpoint_auth_method: "none",
        grant_types: ["authorization_code", "refresh_token"],
      }),
    );
    await verifyClaudeClient(f);
    expect(String(f.mock.calls[0]?.[0])).toBe(CLAUDE_CLIENT);
    await expect(
      verifyClaudeClient(async () =>
        Response.json({ redirect_uris: ["https://evil.test"] }),
      ),
    ).rejects.toMatchObject({ code: "CLAUDE_CLIENT_UNAVAILABLE" });
  });
});

describe("OAuth atomic claims and failure recovery", () => {
  it("lets only one concurrent code exchange create a session", async () => {
    const s = setup();
    try {
      const a = await approved(s),
        body = {
          grant_type: "authorization_code",
          client_id: CLAUDE_CLIENT,
          code: a.code,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: verifier,
        };
      const results = await Promise.allSettled([
        s.service.exchange(body),
        s.service.exchange(body),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(await s.service.sessions(actor)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("rolls back code consumption and session creation if token persistence fails", async () => {
    const s = setup();
    try {
      const a = await approved(s),
        original = s.memory.db.batch!.bind(s.memory.db),
        body = {
          grant_type: "authorization_code",
          client_id: CLAUDE_CLIENT,
          code: a.code,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: verifier,
        };
      s.memory.db.batch = (statements) =>
        original([
          ...statements,
          s.memory.db.prepare("INSERT INTO synthetic_missing_table VALUES(1)"),
        ]);
      await expect(s.service.exchange(body)).rejects.toThrow();
      expect(await s.service.sessions(actor)).toHaveLength(0);
      s.memory.db.batch = original;
      const c = await s.service.exchange(body);
      expect((await s.service.authenticate(c.access_token)).userId).toBe(
        "owner",
      );
    } finally {
      s.memory.close();
    }
  });
  it("revokes the session family when the same refresh token is raced", async () => {
    const s = setup();
    try {
      const c = await connect(s);
      const body = {
        grant_type: "refresh_token",
        client_id: CLAUDE_CLIENT,
        refresh_token: c.tokens.refresh_token,
      };
      const results = await Promise.allSettled([
        s.service.exchange(body),
        s.service.exchange(body),
      ]);
      const issued = results.filter((r) => r.status === "fulfilled");
      expect(issued).toHaveLength(1);
      expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect((await s.service.sessions(actor))[0].revoked).toBe(true);
      await expect(
        s.service.authenticate(c.tokens.access_token),
      ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
      for (const result of issued) {
        if (result.status !== "fulfilled") continue;
        await expect(
          s.service.authenticate(result.value.access_token),
        ).rejects.toMatchObject({ code: "INVALID_TOKEN" });
        await expect(
          s.service.exchange({
            ...body,
            refresh_token: result.value.refresh_token,
          }),
        ).rejects.toMatchObject({ code: "INVALID_GRANT" });
      }
    } finally {
      s.memory.close();
    }
  });
  it("does not extend the original session lifetime through refresh", async () => {
    const s = setup();
    try {
      const c = await connect(s),
        start = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(start + 29 * 86400000);
      const next = await s.service.exchange({
        grant_type: "refresh_token",
        client_id: CLAUDE_CLIENT,
        refresh_token: c.tokens.refresh_token,
      });
      await s.service.authenticate(next.access_token);
      vi.spyOn(Date, "now").mockReturnValue(start + 30 * 86400000 + 1);
      await expect(
        s.service.exchange({
          grant_type: "refresh_token",
          client_id: CLAUDE_CLIENT,
          refresh_token: next.refresh_token,
        }),
      ).rejects.toMatchObject({ code: "INVALID_GRANT" });
    } finally {
      s.memory.close();
    }
  });
  it("fails closed before consuming a code if atomic storage is unavailable", async () => {
    const s = setup();
    try {
      const a = await approved(s);
      const original = s.memory.db.batch;
      s.memory.db.batch = undefined;
      const body = {
        grant_type: "authorization_code",
        client_id: CLAUDE_CLIENT,
        code: a.code,
        redirect_uri: CLAUDE_REDIRECT,
        code_verifier: verifier,
      };
      await expect(s.service.exchange(body)).rejects.toMatchObject({
        code: "CLAUDE_AUTH_STORAGE",
      });
      expect(await s.service.sessions(actor)).toHaveLength(0);
      s.memory.db.batch = original;
      const tokens = await s.service.exchange(body);
      await s.service.authenticate(tokens.access_token);
    } finally {
      s.memory.close();
    }
  });
  it("bounds unauthenticated pending authorization requests", async () => {
    const s = setup();
    try {
      for (let i = 0; i < 50; i++) await pending(s);
      await expect(pending(s)).rejects.toMatchObject({
        code: "CLAUDE_AUTH_RATE_LIMIT",
      });
      expect(await s.service.sessions(actor)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("rejects oversized provider metadata as a bounded stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(25001));
      },
      cancel() {
        cancelled = true;
      },
    });
    await expect(
      verifyClaudeClient(
        async () =>
          new Response(body, {
            headers: { "Content-Type": "application/json" },
          }),
      ),
    ).rejects.toMatchObject({ code: "CLAUDE_CLIENT_UNAVAILABLE" });
    expect(cancelled).toBe(true);
  });
});
