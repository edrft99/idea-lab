import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as prepare } from "../app/api/merges/prepare/route";
import { POST as commit } from "../app/api/merges/commit/route";
import { POST as status } from "../app/api/merges/status/route";
import { POST as resume } from "../app/api/merges/resume/route";
import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { Operations } from "../lib/ideas/operations";
import { memoryDB, config, ids } from "./fixtures";
const owner = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const env = { IDEA_LAB_OWNER_USER_ID: "owner" };
const req = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/merges", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
});
afterEach(() => vi.restoreAllMocks());
describe("merge-ideas API guards", () => {
  it.each([prepare, commit, status, resume])(
    "requires trusted identity and owner before provider access",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect(
        (await runWithIdeaRuntime(env, () => handler(req({})))).status,
      ).toBe(401);
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect(
        (await runWithIdeaRuntime(env, () => handler(req({})))).status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it.each([prepare, commit, status, resume])(
    "rejects external origins, malformed or extra commands",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            handler(req({}, "https://external.test")),
          )
        ).status,
      ).toBe(403);
      const response = await runWithIdeaRuntime(env, () =>
        handler(req({ merge: true, operationId: "a".repeat(64) })),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("dispatches merge status after reload without sending any provider mutation", async () => {
    const m = memoryDB();
    try {
      const ops = new Operations(m.db),
        receipt = await ops.issue(
          "owner",
          "hash",
          "merge-ideas",
          "pair:test",
          null,
        );
      const fetcher = vi.spyOn(globalThis, "fetch");
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
        () => reconcile(req({ operationId: receipt.id })),
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as { data: unknown }).data).toMatchObject(
        { status: "pending", canResume: false },
      );
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      m.close();
    }
  });
});
