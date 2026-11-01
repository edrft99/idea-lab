import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { POST, GET } from "../app/mcp/route";
import { POST as approve } from "../app/api/assistant-capture/approve/route";
import { GET as review } from "../app/api/assistant-capture/[id]/route";
import { runWithIdeaRuntime, type RuntimeEnv } from "../lib/ideas/runtime";
import { setup } from "./proposal-fixtures";
import { config, ids, input } from "./fixtures";
const user = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const base: RuntimeEnv = {
  IDEA_LAB_OWNER_USER_ID: "owner",
  NOTION_TOKEN: config.token,
  NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
  NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
  NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
  NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
};
const request = (body: unknown, origin?: string, version?: string) =>
  new Request("https://idea.test/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(origin ? { Origin: origin } : {}),
      ...(version ? { "MCP-Protocol-Version": version } : {}),
    },
    body: JSON.stringify(body),
  });
const rpc = (method: string, params?: unknown) => ({
  jsonrpc: "2.0",
  id: 1,
  method,
  ...(params ? { params } : {}),
});
async function call(
  body: unknown,
  env = base,
  origin?: string,
  version?: string,
) {
  const r = await runWithIdeaRuntime(env, () =>
    POST(request(body, origin, version)),
  );
  return { r, b: (await r.json()) as any };
}
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(user);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("MCP protocol and browser approval", () => {
  it("rejects anonymous discovery before any provider call", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue(null);
    const f = vi.spyOn(globalThis, "fetch");
    expect((await call(rpc("server/discover"))).r.status).toBe(401);
    expect(f).not.toHaveBeenCalled();
  });
  it("rejects a different authenticated owner", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue({ ...user, userId: "other" });
    expect((await call(rpc("tools/list"))).r.status).toBe(403);
  });
  it("discovers all six tools without a Notion token or DB", async () => {
    const env = { ...base, NOTION_TOKEN: "" };
    const d = await call(rpc("server/discover"), env);
    expect(d.b.result.supportedVersions).toContain("2026-07-28");
    const t = await call(rpc("tools/list"), env);
    expect(t.b.result.tools.map((t: any) => t.name)).toEqual([
      "search_ideas",
      "get_idea",
      "propose_idea",
      "save_idea",
      "update_idea",
      "find_similar_ideas",
    ]);
    expect(t.r.headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      t.b.result.tools.filter((t: any) => t.annotations.readOnlyHint),
    ).toHaveLength(3);
  });
  it("negotiates initialize and handles ping without persistence", async () => {
    const i = await call(
      rpc("initialize", {
        protocolVersion: "future",
        capabilities: {},
        clientInfo: { name: "fixture", version: "1" },
      }),
    );
    expect(i.b.result.protocolVersion).toBe("2026-07-28");
    expect((await call(rpc("ping"))).b.result).toMatchObject({
      resultType: "complete",
    });
  });
  it("rejects unknown methods, tools, batches and protocol versions", async () => {
    expect((await call(rpc("approve"))).b.error.code).toBe(-32601);
    expect(
      (await call(rpc("tools/call", { name: "approve", arguments: {} }))).b
        .error.code,
    ).toBe(-32602);
    expect((await call([rpc("ping")])).b.error.code).toBe(-32600);
    expect((await call(rpc("ping"), base, undefined, "old")).r.status).toBe(
      400,
    );
  });
  it("rejects foreign Origin even when authenticated", async () => {
    expect((await call(rpc("ping"), base, "https://evil.test")).r.status).toBe(
      403,
    );
  });
  it("returns 405 for GET and 202 for accepted notifications", async () => {
    const g = await runWithIdeaRuntime(base, () =>
      GET(new Request("https://idea.test/mcp")),
    );
    expect(g.status).toBe(405);
    expect(g.headers.get("Allow")).toBe("POST");
    const n = await runWithIdeaRuntime(base, () =>
      POST(
        request({
          jsonrpc: "2.0",
          method: "notifications/cancelled",
          params: { requestId: 1 },
        }),
      ),
    );
    expect(n.status).toBe(202);
    expect(await n.text()).toBe("");
  });
  it("rejects malformed JSON and bounds streaming bodies", async () => {
    for (const [body, status] of [
      ["{", 400],
      [JSON.stringify({ x: "x".repeat(96001) }), 413],
    ] as const) {
      const r = await runWithIdeaRuntime(base, () =>
        POST(
          new Request("https://idea.test/mcp", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body,
          }),
        ),
      );
      expect(r.status).toBe(status);
    }
  });
  it("validates declared arguments before constructing storage", async () => {
    for (const args of [
      { proposalId: "wrong" },
      { proposalId: "a".repeat(64), approved: true },
    ])
      expect(
        (await call(rpc("tools/call", { name: "save_idea", arguments: args })))
          .b.error.code,
      ).toBe(-32602);
  });
  it.each(["Claude", "ChatGPT"])(
    "stages %s through MCP, saves only after browser approval, and returns one canonical result on replay",
    async (client) => {
      const s = setup(),
        env = { ...base, DB: s.memory.db };
      vi.spyOn(globalThis, "fetch").mockImplementation(s.fetcher);
      try {
        const p = await call(
          rpc("tools/call", {
            name: "propose_idea",
            arguments: {
              captureId: "80000000-0000-4000-8000-000000000008",
              client,
              data: input,
              evidence: "Selected portable sensor kit idea.",
            },
          }),
          env,
        );
        expect(p.b.result.isError).toBe(false);
        const draft = p.b.result.structuredContent;
        expect(draft.reviewUrl).toBe(
          "https://idea.test/capture/assistant/" + draft.proposalId,
        );
        expect(JSON.stringify(draft)).not.toContain("approvalToken");
        expect(s.writes()).toHaveLength(0);
        const pending = await call(
          rpc("tools/call", {
            name: "save_idea",
            arguments: { proposalId: draft.proposalId },
            _meta: { approved: true },
          }),
          env,
        );
        expect(pending.b.result.structuredContent.requiresHumanApproval).toBe(
          true,
        );
        expect(s.writes()).toHaveLength(0);
        const view = await runWithIdeaRuntime(env, () =>
          review(new Request(draft.reviewUrl), {
            params: Promise.resolve({ id: draft.proposalId }),
          }),
        );
        expect(((await view.json()) as any).data.canApprove).toBe(true);
        for (const origin of [undefined, "https://evil.test"]) {
          const denied = await runWithIdeaRuntime(env, () =>
            approve(request({ proposalId: draft.proposalId }, origin)),
          );
          expect(denied.status).toBe(403);
        }
        expect(s.writes()).toHaveLength(0);
        const saved = await runWithIdeaRuntime(env, () =>
          approve(
            request({ proposalId: draft.proposalId }, "https://idea.test"),
          ),
        );
        expect(saved.status).toBe(200);
        expect(((await saved.json()) as any).data.status).toBe("done");
        expect(s.writes(ids.ideas)).toHaveLength(1);
        expect(s.writes(ids.sources)).toHaveLength(1);
        const again = await call(
          rpc("tools/call", {
            name: "save_idea",
            arguments: { proposalId: draft.proposalId },
          }),
          env,
        );
        expect(again.b.result.structuredContent.status).toBe("done");
        expect(again.b.result.structuredContent.canonicalUrl).toContain(
          ids.idea,
        );
        expect(s.writes(ids.ideas)).toHaveLength(1);
        expect(
          s.events.every(
            (e) =>
              e.path.startsWith("pages") || e.path.startsWith("data_sources"),
          ),
        ).toBe(true);
      } finally {
        s.memory.close();
      }
    },
  );
});

describe("current MCP request metadata compatibility", () => {
  const meta = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientCapabilities": {},
    "io.modelcontextprotocol/clientInfo": {
      name: "Sites tool discovery",
      version: "1",
    },
  };
  it("accepts the platform tool-list request with per-request metadata", async () => {
    const req = new Request("https://idea.test/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Mcp-Method": "tools/list",
        "MCP-Protocol-Version": "2026-07-28",
      },
      body: JSON.stringify(rpc("tools/list", { _meta: meta })),
    });
    const r = await runWithIdeaRuntime({ ...base, NOTION_TOKEN: "" }, () =>
      POST(req),
    );
    const b = (await r.json()) as any;
    expect(r.status).toBe(200);
    expect(b.result.resultType).toBe("complete");
    expect(b.result.tools).toHaveLength(6);
  });
  it("rejects mismatched routing/version headers without provider calls", async () => {
    const f = vi.spyOn(globalThis, "fetch");
    for (const h of [
      { "Mcp-Method": "tools/call" },
      { "MCP-Protocol-Version": "2025-11-25" },
      { "Mcp-Name": "approve" },
    ] as Record<string, string>[]) {
      const req = new Request("https://idea.test/mcp", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "MCP-Protocol-Version": "2026-07-28",
          ...h,
        },
        body: JSON.stringify(rpc("tools/list", { _meta: meta })),
      });
      const r = await runWithIdeaRuntime(base, () => POST(req));
      expect(((await r.json()) as any).error.code).toBe(-32020);
    }
    expect(f).not.toHaveBeenCalled();
  });
  it("accepts legacy metadata without allowing it to approve writes", async () => {
    const { b } = await call(rpc("tools/list", { _meta: { approved: true } }));
    expect(b.result.tools.some((t: any) => t.name === "approve")).toBe(false);
    expect(b.result.tools).toHaveLength(6);
    expect(
      (await call(rpc("tools/list", { cursor: "invented" }))).b.error.code,
    ).toBe(-32602);
  });
});
