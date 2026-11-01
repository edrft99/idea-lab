import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as storePrepare } from "../app/api/assessment-proposals/store/prepare/route";
import { POST as storeCommit } from "../app/api/assessment-proposals/store/commit/route";
import { POST as storeStatus } from "../app/api/assessment-proposals/store/status/route";
import { POST as prepare } from "../app/api/assessment-proposals/decision/prepare/route";
import { POST as commit } from "../app/api/assessment-proposals/decision/commit/route";
import { POST as status } from "../app/api/assessment-proposals/decision/status/route";
import { POST as resume } from "../app/api/assessment-proposals/resume/route";
import { GET as read } from "../app/api/assessment-proposals/[id]/route";
import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { setup as provider } from "./proposal-fixtures";
import { draft } from "./assessment-fixtures";
import { page, idea } from "./fixtures";
import { AssessmentRepository } from "../lib/evaluations/proposal-repository";
import { AssessmentService } from "../lib/evaluations/proposal-service";
import { assessmentStoreSchema } from "../lib/evaluations/proposal-model";
const command = assessmentStoreSchema.parse({
  ideaId: ids.idea,
  inputRevision: idea.revision,
  draft,
  note: "Synthetic assessment review",
});
function setup() {
  const s = provider();
  s.rows.set(ids.idea, page());
  const repo = new AssessmentRepository(config, s.fetcher);
  return { ...s, repo, service: new AssessmentService(repo, s.ops) };
}
import { config, ids } from "./fixtures";
const owner = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  env = { IDEA_LAB_OWNER_USER_ID: "owner" };
const request = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/proposals/test", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("assessment proposal API boundary", () => {
  it.each([
    storePrepare,
    storeCommit,
    storeStatus,
    prepare,
    commit,
    status,
    resume,
  ])(
    "requires owner identity, same origin and strict input before accessing Notion",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect(
        (await runWithIdeaRuntime(env, () => handler(request({})))).status,
      ).toBe(401);
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect(
        (await runWithIdeaRuntime(env, () => handler(request({})))).status,
      ).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue(owner);
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            handler(request({}, "https://external.test")),
          )
        ).status,
      ).toBe(403);
      const invalid = await runWithIdeaRuntime(env, () =>
        handler(request({ unknown: true })),
      );
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("protects proposal reads and rejects invalid record identifiers", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch"),
      req = new Request("https://idea.test");
    vi.mocked(getChatGPTUser).mockResolvedValue(null);
    expect(
      (
        await runWithIdeaRuntime(env, () =>
          read(req, { params: Promise.resolve({ id: ids.idea }) }),
        )
      ).status,
    ).toBe(401);
    vi.mocked(getChatGPTUser).mockResolvedValue(owner);
    expect(
      (
        await runWithIdeaRuntime(env, () =>
          read(req, { params: Promise.resolve({ id: "foreign/path" }) }),
        )
      ).status,
    ).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("reconciles interrupted assessment storage through the common Recent Saves endpoint", async () => {
    const s = setup();
    try {
      const a = await s.service.prepareStore(command, "owner");
      s.faults.lostCreate = ids.reviews;
      await expect(
        s.service.store(command, a.approvalToken, "owner"),
      ).rejects.toThrow();
      vi.spyOn(globalThis, "fetch").mockImplementation(s.fetcher);
      const op = await s.ops.read(a.approvalToken, "owner");
      const response = await runWithIdeaRuntime(
        {
          ...env,
          DB: s.memory.db,
          NOTION_TOKEN: config.token,
          NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
          NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
          NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
          NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
        },
        () => reconcile(request({ operationId: op.id })),
      );
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).data).toMatchObject({
        status: "done",
        canResume: false,
      });
      expect(s.writes(ids.reviews)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
});
