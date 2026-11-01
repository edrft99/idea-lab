import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import {
  GET as oauthGet,
  POST as oauthPost,
} from "../app/api/claude/auth/[action]/route";
import {
  GET as consentGet,
  POST as consentPost,
} from "../app/api/claude/connections/[action]/route";
import { POST as mcpPost, GET as mcpGet } from "../app/api/claude/mcp/route";
import { POST as approveCapture } from "../app/api/assistant-capture/approve/route";
import { relay } from "../claude-gateway/worker/index.js";
import { runWithIdeaRuntime, type RuntimeEnv } from "../lib/ideas/runtime";
import { CLAUDE_CLIENT, CLAUDE_REDIRECT } from "../lib/claude-auth/model";
import { challenge } from "../lib/claude-auth/service";
import { setup } from "./proposal-fixtures";
import { config, ids, input } from "./fixtures";
const user = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  publicOrigin = "https://relay.test",
  privateOrigin = "https://idea.test",
  relayKey = "r".repeat(64),
  proof = "v".repeat(64);
const relayEnv = {
  IDEA_LAB_SITE_ORIGIN: privateOrigin,
  IDEA_LAB_CLAUDE_RELAY_KEY: relayKey,
  IDEA_LAB_SITE_SERVICE_TOKEN: "synthetic-private-site-service-token",
};
function harness() {
  const s = setup(),
    env: RuntimeEnv = {
      DB: s.memory.db,
      IDEA_LAB_OWNER_USER_ID: "owner",
      IDEA_LAB_SITE_ORIGIN: privateOrigin,
      IDEA_LAB_CLAUDE_ORIGIN: publicOrigin,
      IDEA_LAB_CLAUDE_RELAY_KEY: relayKey,
      NOTION_TOKEN: config.token,
      NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
      NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
      NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
      NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
    };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, options) =>
    String(url) === CLAUDE_CLIENT
      ? Response.json({
          client_name: "Claude",
          redirect_uris: [CLAUDE_REDIRECT],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
        })
      : s.fetcher(url, options),
  );
  const upstream = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(String(url), init),
      p = new URL(req.url).pathname;
    if (p.startsWith("/api/claude/auth/")) {
      const ctx = { params: Promise.resolve({ action: p.split("/").at(-1)! }) };
      return runWithIdeaRuntime(env, () =>
        req.method === "GET" ? oauthGet(req, ctx) : oauthPost(req, ctx),
      );
    }
    if (p === "/api/claude/mcp")
      return runWithIdeaRuntime(env, () =>
        req.method === "GET" ? mcpGet(req) : mcpPost(req),
      );
    throw new Error("Unexpected fixture relay target");
  });
  const remote = (path: string, init?: RequestInit) =>
    relay(new Request(publicOrigin + path, init), relayEnv, upstream);
  const browser = (action: string, input?: unknown, origin = privateOrigin) => {
    const req = new Request(
        privateOrigin + "/api/claude/connections/" + action,
        {
          method: input ? "POST" : "GET",
          headers: { "Content-Type": "application/json", Origin: origin },
          ...(input ? { body: JSON.stringify(input) } : {}),
        },
      ),
      ctx = { params: Promise.resolve({ action }) };
    return runWithIdeaRuntime(env, () =>
      input ? consentPost(req, ctx) : consentGet(req, ctx),
    );
  };
  const call = async (name: string, args: unknown = {}, token?: string) => {
    const r = await remote("/api/claude/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
        "MCP-Protocol-Version": "2026-07-28",
        "Mcp-Method": "tools/call",
        "Mcp-Name": name,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name,
          arguments: args,
          _meta: {
            "io.modelcontextprotocol/protocolVersion": "2026-07-28",
            "io.modelcontextprotocol/clientCapabilities": {},
          },
        },
      }),
    });
    return { r, body: (await r.json()) as any };
  };
  return { ...s, env, remote, browser, call, upstream };
}
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(user);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("Claude OAuth through public relay and shared capture commands", () => {
  it("connects only after private owner consent, then stages Claude evidence and saves only after separate exact capture approval", async () => {
    const h = harness();
    try {
      const anon = await h.call("search_ideas", {});
      expect(anon.r.status).toBe(401);
      expect(anon.r.headers.get("WWW-Authenticate")).toContain(
        publicOrigin + "/oauth/resource",
      );
      expect(h.events).toHaveLength(0);
      const metadata = await h.remote(
        "/.well-known/oauth-authorization-server",
      );
      expect(
        ((await metadata.json()) as any).client_id_metadata_document_supported,
      ).toBe(true);
      const query = new URLSearchParams({
        response_type: "code",
        client_id: CLAUDE_CLIENT,
        redirect_uri: CLAUDE_REDIRECT,
        code_challenge: await challenge(proof),
        code_challenge_method: "S256",
        scope: "ideas:read ideas:capture",
        resource: publicOrigin + "/api/claude/mcp",
        state: "synthetic-client-state",
      });
      const start = await h.remote("/authorize?" + query);
      expect(start.status).toBe(302);
      const id = new URL(start.headers.get("Location")!).pathname
        .split("/")
        .at(-1)!;
      const view = await h.browser(id),
        v = ((await view.json()) as any).data;
      expect(v.canApprove).toBe(true);
      expect(h.writes()).toHaveLength(0);
      expect(
        (
          await h.browser(
            "decide",
            { requestId: id, decision: "approve", reviewHash: v.reviewHash },
            "https://evil.test",
          )
        ).status,
      ).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue({ ...user, userId: "other" });
      expect((await h.browser(id)).status).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue(user);
      const approved = await h.browser("decide", {
          requestId: id,
          decision: "approve",
          reviewHash: v.reviewHash,
        }),
        callback = new URL(((await approved.json()) as any).data.redirectUrl);
      expect(callback.origin + callback.pathname).toBe(CLAUDE_REDIRECT);
      const token = await h.remote("/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: callback.searchParams.get("code")!,
          client_id: CLAUDE_CLIENT,
          redirect_uri: CLAUDE_REDIRECT,
          code_verifier: proof,
          resource: publicOrigin + "/api/claude/mcp",
        }),
      });
      expect(token.status).toBe(200);
      const credentials = (await token.json()) as any;
      const search = await h.call("search_ideas", {}, credentials.access_token);
      expect(search.body.result.structuredContent.ideas).toEqual([]);
      const bad = await h.call(
        "propose_idea",
        {
          captureId: "80000000-0000-4000-8000-000000000008",
          client: "ChatGPT",
          data: input,
          evidence: "Selected fixture evidence.",
        },
        credentials.access_token,
      );
      expect(bad.body.error.code).toBe(-32602);
      const draft = await h.call(
        "propose_idea",
        {
          captureId: "80000000-0000-4000-8000-000000000008",
          client: "Claude",
          data: input,
          evidence: "Selected fixture evidence.",
        },
        credentials.access_token,
      );
      const p = draft.body.result.structuredContent;
      expect(p.reviewUrl).toBe(
        privateOrigin + "/capture/assistant/" + p.proposalId,
      );
      expect(h.writes()).toHaveLength(0);
      const waiting = await h.call(
        "save_idea",
        { proposalId: p.proposalId },
        credentials.access_token,
      );
      expect(waiting.body.result.structuredContent.requiresHumanApproval).toBe(
        true,
      );
      expect(h.writes()).toHaveLength(0);
      const save = await runWithIdeaRuntime(h.env, () =>
        approveCapture(
          new Request(privateOrigin + "/api/assistant-capture/approve", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Origin: privateOrigin,
            },
            body: JSON.stringify({ proposalId: p.proposalId }),
          }),
        ),
      );
      expect(save.status).toBe(200);
      expect(h.writes(ids.ideas)).toHaveLength(1);
      expect(h.writes(ids.sources)).toHaveLength(1);
      const done = await h.call(
        "save_idea",
        { proposalId: p.proposalId },
        credentials.access_token,
      );
      expect(done.body.result.structuredContent.status).toBe("done");
      expect(h.writes(ids.ideas)).toHaveLength(1);
      expect(
        [...h.rows.values()].find(
          (p) => p.parent.data_source_id === ids.sources,
        )?.properties["Source System"].select.name,
      ).toBe("Claude");
      const sessions = await h.browser("sessions");
      const session = ((await sessions.json()) as any).data[0];
      await h.browser("revoke", { sessionId: session.id });
      expect(
        (await h.call("search_ideas", {}, credentials.access_token)).r.status,
      ).toBe(401);
    } finally {
      h.memory.close();
    }
  });
  it("requires an independent server relay key, rejects repeated OAuth parameters and keeps setup disabled until configured", async () => {
    const h = harness();
    try {
      const ctx = { params: Promise.resolve({ action: "metadata" }) };
      const denied = await runWithIdeaRuntime(h.env, () =>
        oauthGet(new Request(privateOrigin + "/api/claude/auth/metadata"), ctx),
      );
      expect(denied.status).toBe(401);
      const duplicate = await h.remote("/authorize?client_id=a&client_id=b");
      expect(duplicate.status).toBe(400);
      expect(h.writes()).toHaveLength(0);
      const unavailable = await runWithIdeaRuntime(
        { ...h.env, IDEA_LAB_CLAUDE_ORIGIN: "" },
        () =>
          oauthGet(
            new Request(privateOrigin + "/api/claude/auth/metadata", {
              headers: { "X-Idea-Lab-Relay-Key": relayKey },
            }),
            ctx,
          ),
      );
      expect(unavailable.status).toBe(503);
    } finally {
      h.memory.close();
    }
  });
});
