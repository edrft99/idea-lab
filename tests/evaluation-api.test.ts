import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { memoryDB, ids, config, page } from "./fixtures";
import { Operations, digest } from "../lib/ideas/operations";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as prepare } from "../app/api/evaluations/prepare/route";
import { POST as commit } from "../app/api/evaluations/commit/route";
import { POST as status } from "../app/api/evaluations/status/route";
const owner = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const env = { IDEA_LAB_OWNER_USER_ID: "owner" };
const req = (value: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/evaluations/prepare", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("evaluation API owner and approval boundary", () => {
  it.each([prepare, commit, status])(
    "requires identity before any provider access",
    async (handler) => {
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      const fetcher = vi.spyOn(globalThis, "fetch");
      const response = await runWithIdeaRuntime(env, () => handler(req({})));
      expect(response.status).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects another owner and cross-site submissions", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue({ ...owner, userId: "other" });
    expect((await runWithIdeaRuntime(env, () => prepare(req({})))).status).toBe(
      403,
    );
    vi.mocked(getChatGPTUser).mockResolvedValue(owner);
    expect(
      (
        await runWithIdeaRuntime(env, () =>
          prepare(req({}, "https://other.test")),
        )
      ).status,
    ).toBe(403);
  });
  it.each([prepare, commit, status])(
    "rejects malformed or forged request shapes before credential lookup",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      const response = await runWithIdeaRuntime(env, () =>
        handler(req({ autoApprove: true, ratings: { impact: 5 } })),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );

  it("dispatches a prior history save to evaluation reconciliation after reload", async () => {
    const m = memoryDB(),
      ops = new Operations(m.db),
      r = await ops.issue(
        "owner",
        await digest("evaluation"),
        "evaluation-history",
        ids.idea,
        "revision",
      );
    await ops.claim(
      await ops.read(r.token, "owner"),
      await digest("evaluation"),
    );
    await ops.finish(r.id, "uncertain");
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        results: [
          page({
            id: "70000000-0000-4000-8000-000000000007",
            parent: {
              type: "data_source_id",
              data_source_id: ids.evaluations,
            },
            properties: {
              "Related Idea": {
                type: "relation",
                relation: [{ id: ids.idea }],
              },
            },
          }),
        ],
        has_more: false,
      }),
    );
    const response = await runWithIdeaRuntime(
      {
        ...env,
        DB: m.db,
        NOTION_TOKEN: config.token,
        NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
        NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
        NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
        NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
      },
      () => reconcile(req({ operationId: r.id })),
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { data: unknown }).data).toMatchObject({
      status: "done",
      ideaId: ids.idea,
      evaluationId: "70000000-0000-4000-8000-000000000007",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "data_sources/" + ids.evaluations + "/query",
    );
    m.close();
  });
});
