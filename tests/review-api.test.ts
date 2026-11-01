import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as prepare } from "../app/api/reviews/prepare/route";
import { POST as commit } from "../app/api/reviews/commit/route";
import { POST as status } from "../app/api/reviews/status/route";
import { GET as comparison } from "../app/api/reviews/comparison/route";
import { GET as review } from "../app/api/reviews/[id]/route";
import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { Operations, digest } from "../lib/ideas/operations";
import { pairKey } from "../lib/reviews/model";
import { memoryDB, idea, ids, config, page } from "./fixtures";
const owner = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  env = { IDEA_LAB_OWNER_USER_ID: "owner" },
  matchingId = "70000000-0000-4000-8000-000000000007",
  decisionId = "90000000-0000-4000-8000-000000000009";
const req = (value: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/reviews/prepare", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("relationship API authorization and exact-write boundary", () => {
  it.each([prepare, commit, status])(
    "requires identity before looking up provider credentials",
    async (handler) => {
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      const fetcher = vi.spyOn(globalThis, "fetch");
      expect(
        (await runWithIdeaRuntime(env, () => handler(req({})))).status,
      ).toBe(401);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("protects read endpoints and rejects bad or self-pair queries", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue({ ...owner, userId: "other" });
    expect(
      (
        await runWithIdeaRuntime(env, () =>
          comparison(new Request("https://idea.test/api/reviews/comparison")),
        )
      ).status,
    ).toBe(403);
    vi.mocked(getChatGPTUser).mockResolvedValue(owner);
    const response = await runWithIdeaRuntime(env, () =>
      comparison(
        new Request(
          "https://idea.test/api/reviews/comparison?candidateId=" +
            idea.id +
            "&matchingId=" +
            idea.id,
        ),
      ),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(
      (
        await runWithIdeaRuntime(env, () =>
          review(new Request("https://idea.test"), {
            params: Promise.resolve({ id: "foreign-path" }),
          }),
        )
      ).status,
    ).toBe(404);
  });
  it.each([prepare, commit, status])(
    "rejects unknown/malformed fields and cross-origin submissions",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            handler(req({ merge: true, approve: true })),
          )
        ).status,
      ).toBe(400);
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            handler(req({}, "https://other.test")),
          )
        ).status,
      ).toBe(403);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("routes an uncertain decision to review reconciliation after reload", async () => {
    const m = memoryDB(),
      ops = new Operations(m.db),
      key = await pairKey(idea.id, matchingId),
      hash = await digest("decision"),
      r = await ops.issue("owner", hash, "review-decision", key, null);
    await ops.claim(await ops.read(r.token, "owner"), hash, [
      idea.id,
      matchingId,
    ]);
    await ops.finish(r.id, "uncertain");
    const rich = (value: string) => ({
      type: "rich_text",
      rich_text: [{ type: "text", text: { content: value } }],
    });
    const snapshot = {
      format: "idea-lab-relationship",
      version: 1,
      candidateId: idea.id,
      matchingId,
      candidateRevision: "r1",
      matchingRevision: "r2",
      candidateHash: "a".repeat(64),
      matchingHash: "b".repeat(64),
      decision: "Related",
      reason: "Independent outcomes.",
      operation: r.id,
      origin: "manual",
      scope: "classification-only",
      originalReviewId: null,
    };
    const properties = {
      Name: { type: "title", title: [{ plain_text: "Manual related review" }] },
      Status: { type: "select", select: { name: "Approved" } },
      "Candidate Idea": { type: "relation", relation: [{ id: idea.id }] },
      "Potential Matching Idea": {
        type: "relation",
        relation: [{ id: matchingId }],
      },
      "Candidate Revision": rich("r1"),
      "Match Revision": rich("r2"),
      "Pair Key": rich(key),
      "Operation ID": rich(r.id),
      "Proposal Payload": rich(JSON.stringify(snapshot)),
    };
    const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        results: [
          page({
            id: decisionId,
            parent: { type: "data_source_id", data_source_id: ids.reviews },
            properties,
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
      decisionId,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(String(fetcher.mock.calls[0][0])).toContain(
      "data_sources/" + ids.reviews + "/query",
    );
    m.close();
  });
});
