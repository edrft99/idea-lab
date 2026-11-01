import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime, type RuntimeEnv } from "../lib/ideas/runtime";
import { GET as list } from "../app/api/ideas/route";
import { GET as detail } from "../app/api/ideas/[id]/route";
import { POST as prepare } from "../app/api/approvals/route";
import { POST as commit } from "../app/api/ideas/commit/route";
import { GET as connection } from "../app/api/connection/route";
import { config, ids, input, idea, page, schema } from "./fixtures";
const user = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const environment: RuntimeEnv = {
  IDEA_LAB_OWNER_USER_ID: "owner",
  NOTION_TOKEN: config.token,
  NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
  NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
  NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
  NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
};
function post(value: unknown, origin = "https://idea.test") {
  return new Request("https://idea.test/api/approvals", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify(value),
  });
}
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(user);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
describe("API authorization and mutation boundary", () => {
  it("returns 401 before looking up connection settings", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue(null);
    const fetcher = vi.spyOn(globalThis, "fetch");
    const r = await runWithIdeaRuntime(environment, () =>
      list(new Request("https://idea.test/api/ideas")),
    );
    expect(r.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns 403 for a different user even if their email matches", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue({ ...user, userId: "other" });
    const r = await runWithIdeaRuntime(
      { ...environment, IDEA_LAB_OWNER_EMAIL: user.email },
      () => list(new Request("https://idea.test/api/ideas")),
    );
    expect(r.status).toBe(403);
  });
  it("does not authorize someone when owner configuration is absent", async () => {
    const r = await runWithIdeaRuntime(
      { ...environment, IDEA_LAB_OWNER_USER_ID: "", IDEA_LAB_OWNER_EMAIL: "" },
      () => list(new Request("https://idea.test/api/ideas")),
    );
    expect(r.status).toBe(503);
    expect((await readBody(r)).error.code).toBe("OWNER_CONFIGURATION_REQUIRED");
  });
  it("returns a setup error without exposing the token or using demo data", async () => {
    const r = await runWithIdeaRuntime(
      { ...environment, NOTION_TOKEN: "" },
      () => list(new Request("https://idea.test/api/ideas")),
    );
    expect(r.status).toBe(503);
    expect((await readBody(r)).error.code).toBe("NOTION_TOKEN_REQUIRED");
  });
  it("rejects invalid filters without reaching Notion", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      list(new Request("https://idea.test/api/ideas?status=Surprise")),
    );
    expect(r.status).toBe(400);
  });
  it("returns 404 for malformed IDs before retrieving arbitrary pages", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      detail(new Request("https://idea.test/api/ideas/x"), {
        params: Promise.resolve({ id: "not-a-record" }),
      }),
    );
    expect(r.status).toBe(404);
  });
  it("rejects cross-origin approval requests", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      prepare(
        post({ action: "create", data: input }, "https://elsewhere.test"),
      ),
    );
    expect(r.status).toBe(403);
    expect((await readBody(r)).error.code).toBe("INVALID_ORIGIN");
  });
  it("requires an Origin even when an authenticated client calls directly", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      prepare(
        new Request("https://idea.test/api/approvals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "create", data: input }),
        }),
      ),
    );
    expect(r.status).toBe(403);
  });
  it("rejects score/property injection", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      prepare(
        post({ action: "create", data: { ...input, priorityScore: 100 } }),
      ),
    );
    expect(r.status).toBe(400);
  });
  it("bounds the actual streaming body rather than trusting Content-Length", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      prepare(post({ data: "x".repeat(25000) })),
    );
    expect(r.status).toBe(413);
  });
  it("requires a durable operation ledger for saving", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      prepare(post({ action: "create", data: input })),
    );
    expect(r.status).toBe(503);
    expect((await readBody(r)).error.code).toBe("WRITE_COORDINATOR_REQUIRED");
  });
  it("does not accept a forged approval token", async () => {
    const r = await runWithIdeaRuntime(environment, () =>
      commit(
        post({
          command: { action: "create", data: input },
          approvalToken: "fake",
        }),
      ),
    );
    expect(r.status).toBe(400);
  });
  it("returns private no-store responses and real empty collections", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url) => {
        const path = String(url);
        if (path.endsWith("/data_sources/" + ids.ideas))
          return Response.json(schema());
        if (path.endsWith("/data_sources/" + ids.sources))
          return Response.json({
            properties: {
              "Related Idea": { id: "relation", type: "relation" },
              "Source System": { id: "system", type: "select" },
            },
          });
        return Response.json({
          results: [],
          has_more: false,
          next_cursor: null,
        });
      });
    const r = await runWithIdeaRuntime(environment, () =>
      list(new Request("https://idea.test/api/ideas")),
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("private, no-store");
    expect((await readBody(r)).data).toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it("request-scoped settings do not leak between callers", async () => {
    const a = await runWithIdeaRuntime(
      { ...environment, NOTION_TOKEN: "" },
      () => connection(),
    );
    const b = await runWithIdeaRuntime(
      { ...environment, IDEA_LAB_OWNER_USER_ID: "different" },
      () => connection(),
    );
    expect((await readBody(a)).error.code).toBe("NOTION_TOKEN_REQUIRED");
    expect(b.status).toBe(403);
  });
});

async function readBody(response: Response) {
  return (await response.json()) as { error: { code: string }; data: unknown };
}
