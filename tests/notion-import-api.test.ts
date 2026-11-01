import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST } from "../app/api/imports/notion/route";
import { config, ids } from "./fixtures";
const owner = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  pageId = "a0000000-0000-4000-8000-00000000000a",
  sourceId = "e0000000-0000-4000-8000-00000000000e",
  databaseId = "f0000000-0000-4000-8000-00000000000f",
  hub = "11000000-0000-4000-8000-000000000011";
const env = {
  IDEA_LAB_OWNER_USER_ID: "owner",
  NOTION_TOKEN: config.token,
  NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
  NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
  NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
  NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
  NOTION_HUB_URL: "https://www.notion.so/" + hub,
  NOTION_IDEAS_URL: "https://www.notion.so/21000000000040008000000000000021",
  NOTION_SOURCES_URL: "https://www.notion.so/22000000000040008000000000000022",
  NOTION_EVALUATIONS_URL:
    "https://www.notion.so/23000000000040008000000000000023",
  NOTION_REVIEWS_URL: "https://www.notion.so/24000000000040008000000000000024",
};
const request = (value: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/imports/notion", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(value),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("selected Notion API boundary", () => {
  it.each([null, { ...owner, userId: "other" }])(
    "requires the owner before provider access",
    async (user) => {
      vi.mocked(getChatGPTUser).mockResolvedValue(user);
      const fetcher = vi.spyOn(globalThis, "fetch");
      const response = await runWithIdeaRuntime(env, () =>
        POST(
          request({
            action: "page",
            reference: pageId,
            allowContentRead: true,
          }),
        ),
      );
      expect(response.status).toBe(user ? 403 : 401);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects external origins and unsupported input before reading", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    expect(
      (
        await runWithIdeaRuntime(env, () =>
          POST(request({}, "https://other.test")),
        )
      ).status,
    ).toBe(403);
    for (const value of [
      { action: "page", reference: pageId },
      {
        action: "page",
        reference: "https://evil.test/" + pageId,
        allowContentRead: true,
      },
      {
        action: "page",
        reference: pageId,
        allowContentRead: true,
        write: true,
      },
      {
        action: "rows",
        dataSourceId: sourceId,
        pageIds: [pageId, pageId],
        allowContentRead: true,
      },
    ]) {
      const r = await runWithIdeaRuntime(env, () => POST(request(value)));
      expect(r.status).toBe(400);
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("blocks Idea Lab itself without any network read or D1 requirement", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await runWithIdeaRuntime(env, () =>
      POST(request({ action: "page", reference: hub, allowContentRead: true })),
    );
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error.code).toBe(
      "NOTION_SELF_IMPORT",
    );
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("returns selected collection titles while discarding private row bodies", async () => {
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        const path = new URL(String(url)).pathname.replace("/v1/", "");
        if (path === "data_sources/" + sourceId)
          return Response.json({
            object: "data_source",
            id: sourceId,
            parent: { type: "database_id", database_id: databaseId },
            title: [{ plain_text: "Selected collection" }],
          });
        if (path === "databases/" + databaseId)
          return Response.json({
            object: "database",
            id: databaseId,
            parent: { type: "workspace", workspace: true },
          });
        expect(path).toBe("data_sources/" + sourceId + "/query");
        expect(init?.method).toBe("POST");
        return Response.json({
          results: [
            {
              object: "page",
              id: pageId,
              parent: { type: "data_source_id", data_source_id: sourceId },
              last_edited_time: "2026-10-31T10:00:00Z",
              properties: {
                Title: {
                  id: "title",
                  type: "title",
                  title: [{ plain_text: "Selected row" }],
                },
                Private: {
                  type: "rich_text",
                  rich_text: [
                    {
                      plain_text:
                        "Private row content must not be in the metadata response",
                    },
                  ],
                },
              },
            },
          ],
          has_more: false,
        });
      });
    const response = await runWithIdeaRuntime(env, () =>
      POST(
        request({
          action: "list",
          reference: sourceId,
          allowMetadataRead: true,
        }),
      ),
    );
    expect(response.status).toBe(200);
    const raw = await response.text();
    expect(raw).toContain("Selected row");
    expect(raw).not.toContain("Private row content");
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(
      fetcher.mock.calls.every(
        ([url, init]) =>
          init?.method === "GET" ||
          new URL(String(url)).pathname.endsWith("/query"),
      ),
    ).toBe(true);
  });
  it("does not expose provider errors, keys, source text or private paths in logs", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error(config.token + " private-page-body C:/Users/private/notes"),
    );
    const response = await runWithIdeaRuntime(env, () =>
      POST(
        request({ action: "page", reference: pageId, allowContentRead: true }),
      ),
    );
    expect(response.status).toBe(503);
    const output =
      (await response.text()) +
      JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(output).not.toContain(config.token);
    expect(output).not.toContain("private-page-body");
    expect(output).not.toContain("C:/Users/private");
  });
});
