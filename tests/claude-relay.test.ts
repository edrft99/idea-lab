import { describe, it, expect, vi } from "vitest";
import { relay } from "../claude-gateway/worker/index.js";
const env = {
  IDEA_LAB_SITE_ORIGIN: "https://idea.test",
  IDEA_LAB_CLAUDE_RELAY_KEY: "r".repeat(64),
  IDEA_LAB_SITE_SERVICE_TOKEN: "synthetic-site-service-secret",
};
const origin = "https://relay.test";
describe("public Claude relay boundary", () => {
  it("strips client identity/cookies and adds server-only credentials only to the fixed private origin", async () => {
    const f = vi.fn(async (...args: Parameters<typeof fetch>) => {
      const u = new URL(String(args[0])),
        h = new Headers(args[1]?.headers);
      expect(u.origin + u.pathname).toBe("https://idea.test/api/claude/mcp");
      expect(h.get("OAI-Sites-Authorization")).toBe(
        "Bearer " + env.IDEA_LAB_SITE_SERVICE_TOKEN,
      );
      expect(h.get("X-Idea-Lab-Relay-Key")).toBe(env.IDEA_LAB_CLAUDE_RELAY_KEY);
      expect(h.get("X-Idea-Lab-Claude-Authorization")).toBe(
        "Bearer " + "a".repeat(43),
      );
      for (const k of [
        "Cookie",
        "oai-authenticated-user-id",
        "oai-authenticated-user-email",
        "Authorization",
      ])
        expect(h.has(k)).toBe(false);
      return Response.json({ ok: true });
    });
    const r = await relay(
      new Request(origin + "/api/claude/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + "a".repeat(43),
          Cookie: "private=fixture",
          "oai-authenticated-user-id": "attacker",
          "X-Idea-Lab-Relay-Key": "forged",
        },
        body: "{}",
      }),
      env,
      f,
    );
    expect(r.status).toBe(200);
    expect(await r.text()).not.toContain(env.IDEA_LAB_SITE_SERVICE_TOKEN);
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("refuses arbitrary routes, token query strings and foreign origins before reaching the private Site", async () => {
    const f = vi.fn();
    for (const [path, headers] of [
      ["/api/ideas", {}],
      ["/api/claude/mcp?token=fixture", {}],
      ["/oauth/resource", { Origin: "https://evil.test" }],
    ] as const) {
      const r = await relay(new Request(origin + path, { headers }), env, f);
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects oversized request and response streams without reflecting credentials", async () => {
    const f = vi.fn(async () => Response.json({ ok: true }));
    const r = await relay(
      new Request(origin + "/api/claude/mcp", {
        method: "POST",
        body: "x".repeat(96001),
      }),
      env,
      f,
    );
    expect(r.status).toBe(503);
    expect(f).not.toHaveBeenCalled();
    const large = await relay(
      new Request(origin + "/oauth/resource"),
      env,
      async () => new Response("x".repeat(262145)),
    );
    expect(large.status).toBe(503);
  });
  it("does not follow upstream redirects or send credentials to other origins", async () => {
    const f = vi.fn(
      async (..._args: Parameters<typeof fetch>) =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://evil.test/steal" },
        }),
    );
    const r = await relay(
      new Request(origin + "/authorize?client_id=fixture"),
      env,
      f,
    );
    expect(r.status).toBe(502);
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });
  it("permits only an opaque consent redirect back to the private Site", async () => {
    const url = "https://idea.test/claude/connect/" + "a".repeat(64);
    const r = await relay(
      new Request(origin + "/authorize?client_id=fixture"),
      env,
      async () =>
        new Response(null, { status: 302, headers: { Location: url } }),
    );
    expect(r.status).toBe(302);
    expect(r.headers.get("Location")).toBe(url);
    expect(r.headers.has("Set-Cookie")).toBe(false);
  });
  it("advertises the public OAuth metadata on 401 without leaking private gateway settings", async () => {
    const r = await relay(
      new Request(origin + "/api/claude/mcp"),
      env,
      async () => Response.json({ error: "invalid_token" }, { status: 401 }),
    );
    expect(r.status).toBe(401);
    expect(r.headers.get("WWW-Authenticate")).toContain(
      origin + "/oauth/resource",
    );
    expect(r.headers.get("Cache-Control")).toContain("no-store");
  });
  it("fails closed without relay secrets", async () => {
    const f = vi.fn();
    expect(
      (await relay(new Request(origin + "/oauth/resource"), {}, f)).status,
    ).toBe(503);
    expect(f).not.toHaveBeenCalled();
  });
});
