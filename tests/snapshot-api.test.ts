import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as planPreview } from "../app/api/semantic/snapshots/plan/prepare/route";
import { POST as planCommit } from "../app/api/semantic/snapshots/plan/commit/route";
import { POST as batchPreview } from "../app/api/semantic/snapshots/batch/prepare/route";
import { POST as batchCommit } from "../app/api/semantic/snapshots/batch/commit/route";
import { POST as activatePreview } from "../app/api/semantic/snapshots/activate/prepare/route";
import { POST as activateCommit } from "../app/api/semantic/snapshots/activate/commit/route";
import { POST as discardPreview } from "../app/api/semantic/snapshots/discard/prepare/route";
import { POST as discardCommit } from "../app/api/semantic/snapshots/discard/commit/route";
import { GET as list } from "../app/api/semantic/snapshots/route";
import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { POST as queryPreview } from "../app/api/semantic/query/prepare/route";
import { POST as queryCommit } from "../app/api/semantic/query/commit/route";
import { POST as cancel } from "../app/api/semantic/cancel/route";
import { GET as profile } from "../app/api/semantic/status/route";
import { setup } from "./proposal-fixtures";
import { embeddingConfig, queryCommand } from "./semantic-fixtures";
import { ids, config, page, idea } from "./fixtures";
import { Operations } from "../lib/ideas/operations";
const owner = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  ownerEnv = { IDEA_LAB_OWNER_USER_ID: "owner" };
const req = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/semantic/snapshots/request", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
const planCommand = {
  scope: "all-current-canonical-ideas",
  fields: ["title", "summary"],
};
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("snapshot API approval and authority boundary", () => {
  it.each([
    planPreview,
    planCommit,
    batchPreview,
    batchCommit,
    activatePreview,
    activateCommit,
    discardPreview,
    discardCommit,
  ])(
    "enforces owner, origin, strict command and size before provider access",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect(
        (await runWithIdeaRuntime(ownerEnv, () => handler(req({})))).status,
      ).toBe(401);
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect(
        (await runWithIdeaRuntime(ownerEnv, () => handler(req({})))).status,
      ).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue(owner);
      expect(
        (
          await runWithIdeaRuntime(ownerEnv, () =>
            handler(req({}, "https://outside.test")),
          )
        ).status,
      ).toBe(403);
      const response = await runWithIdeaRuntime(ownerEnv, () =>
        handler(req({ approve: true, tool: "send" })),
      );
      expect(response.status).toBe(400);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(
        (
          await runWithIdeaRuntime(ownerEnv, () =>
            handler(req({ payload: "x".repeat(25000) })),
          )
        ).status,
      ).toBe(413);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("returns only owner metadata without model configuration and protects read access", async () => {
    const s = setup();
    try {
      const minimal = { ...ownerEnv, DB: s.memory.db };
      const fetcher = vi.spyOn(globalThis, "fetch");
      const r = await runWithIdeaRuntime(minimal, () => list());
      expect(r.status).toBe(200);
      expect(((await r.json()) as any).data).toMatchObject({
        snapshots: [],
        activeSnapshotId: null,
      });
      expect(fetcher).not.toHaveBeenCalled();
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect((await runWithIdeaRuntime(minimal, () => list())).status).toBe(
        401,
      );
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect((await runWithIdeaRuntime(minimal, () => list())).status).toBe(
        403,
      );
    } finally {
      s.memory.close();
    }
  });
  it("plans, builds, activates and searches through real service/migration boundaries without a Notion write", async () => {
    const s = setup();
    s.rows.set(ids.idea, page());
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === embeddingConfig.endpoint + "embeddings") {
        calls++;
        const inputs = JSON.parse(String(init?.body)).input;
        return Response.json({
          object: "list",
          model: "embedding-model-v1",
          data: inputs.map((_: string, index: number) => ({
            object: "embedding",
            index,
            embedding: [3, 4, 0],
          })),
          usage: { total_tokens: 3 },
        });
      }
      return s.fetcher(url, init);
    });
    const env = {
        ...ownerEnv,
        DB: s.memory.db,
        NOTION_TOKEN: config.token,
        NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
        NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
        NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
        NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
        IDEA_LAB_EMBEDDING_ENDPOINT: embeddingConfig.endpoint,
        IDEA_LAB_EMBEDDING_DEPLOYMENT: embeddingConfig.deployment,
        IDEA_LAB_EMBEDDING_API_KEY: embeddingConfig.key,
        IDEA_LAB_EMBEDDING_DIMENSIONS: "3",
        IDEA_LAB_EMBEDDING_VERSION: embeddingConfig.versionLabel,
        IDEA_LAB_EMBEDDING_RETENTION_NOTICE: embeddingConfig.retentionNotice,
      },
      minimal = { ...ownerEnv, DB: s.memory.db };
    const review = async (
      handler: (r: Request) => Promise<Response>,
      command: unknown,
    ) => {
      const response = await runWithIdeaRuntime(env, () =>
        handler(req(command)),
      );
      expect(response.status).toBe(200);
      const receipt = ((await response.json()) as any).data;
      expect(JSON.stringify(receipt)).not.toContain(embeddingConfig.key);
      return receipt;
    };
    const commit = async (
      handler: (r: Request) => Promise<Response>,
      receipt: any,
    ) => {
      const response = await runWithIdeaRuntime(env, () =>
        handler(
          req({
            command: receipt.command,
            approvalToken: receipt.approvalToken,
          }),
        ),
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as any).data;
    };
    try {
      const r = await review(planPreview, planCommand);
      expect(calls).toBe(0);
      const p = await commit(planCommit, r),
        id = p.snapshotId;
      expect(calls).toBe(0);
      let view = await runWithIdeaRuntime(minimal, () => list());
      expect(((await view.json()) as any).data.snapshots[0]).toMatchObject({
        total: 1,
        built: 0,
        complete: false,
        active: false,
      });
      const b = await review(batchPreview, {
        snapshotId: id,
        ideaIds: [ids.idea],
      });
      expect(calls).toBe(0);
      await commit(batchCommit, b);
      expect(calls).toBe(1);
      const a = await review(activatePreview, { snapshotId: id });
      expect(calls).toBe(1);
      await commit(activateCommit, a);
      expect(calls).toBe(1);
      const status = await runWithIdeaRuntime(minimal, () => profile());
      expect(((await status.json()) as any).data).toMatchObject({
        enabled: false,
        snapshotCount: 1,
        activeSnapshotId: id,
      });
      const q = await review(queryPreview, queryCommand),
        result = await commit(queryCommit, q);
      expect(calls).toBe(2);
      expect(result.snapshotId).toBe(id);
      expect(result.matches[0].idea.url).toBe(idea.url);
      expect(s.writes()).toHaveLength(0);
      const op = await new Operations(s.memory.db).read(
          a.approvalToken,
          "owner",
        ),
        common = await runWithIdeaRuntime(minimal, () =>
          reconcile(req({ operationId: op.id })),
        );
      expect(((await common.json()) as any).data.status).toBe("done");
      const next = await commit(
        planCommit,
        await review(planPreview, planCommand),
      );
      const d = await runWithIdeaRuntime(minimal, () =>
        discardPreview(req({ snapshotId: next.snapshotId })),
      );
      expect(d.status).toBe(200);
      const dr = ((await d.json()) as any).data;
      expect(
        (
          await runWithIdeaRuntime(minimal, () =>
            discardCommit(
              req({ command: dr.command, approvalToken: dr.approvalToken }),
            ),
          )
        ).status,
      ).toBe(200);
      view = await runWithIdeaRuntime(minimal, () => list());
      expect(((await view.json()) as any).data).toMatchObject({
        activeSnapshotId: id,
        snapshots: [expect.objectContaining({ id, active: true })],
      });
      const pending = await review(batchPreview, {
        snapshotId: (
          await commit(planCommit, await review(planPreview, planCommand))
        ).snapshotId,
        ideaIds: [ids.idea],
      });
      expect(
        (
          await runWithIdeaRuntime(minimal, () =>
            cancel(req({ approvalToken: pending.approvalToken })),
          )
        ).status,
      ).toBe(200);
      expect(calls).toBe(2);
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
});
