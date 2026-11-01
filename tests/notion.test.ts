import { describe, it, expect, vi } from "vitest";
import { NotionRepository, decodeIdea, richText } from "../lib/ideas/notion";
import { AppError } from "../lib/ideas/errors";
import { config, ids, input, page, props, schema } from "./fixtures";
describe("Notion transport and boundary", () => {
  it("uses current data-source query and opaque cursors", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          results: [page()],
          has_more: true,
          next_cursor: "opaque+/value=",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ results: [], has_more: false, next_cursor: null }),
      );
    const repo = new NotionRepository(config, request as typeof fetch);
    expect(await repo.query(ids.ideas)).toHaveLength(1);
    expect(request.mock.calls[0][0]).toBe(
      "https://api.notion.com/v1/data_sources/" + ids.ideas + "/query",
    );
    expect(request.mock.calls[0][1].headers["Notion-Version"]).toBe(
      "2026-03-11",
    );
    expect(JSON.parse(request.mock.calls[1][1].body).start_cursor).toBe(
      "opaque+/value=",
    );
  });
  it("rejects repeated pagination instead of looping", async () => {
    const request = vi
      .fn()
      .mockImplementation(async () =>
        Response.json({ results: [], has_more: true, next_cursor: "same" }),
      );
    await expect(
      new NotionRepository(config, request as typeof fetch).query(ids.ideas),
    ).rejects.toMatchObject({ code: "NOTION_PAGINATION_INVALID" });
  });
  it("blocks records outside the configured data source", async () => {
    const request = vi.fn().mockResolvedValue(
      Response.json(
        page({
          parent: { type: "data_source_id", data_source_id: ids.sources },
        }),
      ),
    );
    await expect(
      new NotionRepository(config, request as typeof fetch).page(ids.idea),
    ).rejects.toMatchObject({ status: 404 });
  });
  it("paginates a truncated relation property", async () => {
    const p = props();
    p.Sources = {
      id: "relation:source",
      type: "relation",
      relation: [],
      has_more: true,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page({ properties: p })))
      .mockResolvedValueOnce(
        Response.json({
          results: [{ relation: { id: ids.source } }],
          has_more: false,
          next_cursor: null,
        }),
      );
    const result = await new NotionRepository(
      config,
      request as typeof fetch,
    ).page(ids.idea);
    expect(result.properties.Sources.relation).toEqual([{ id: ids.source }]);
    expect(request.mock.calls[1][0]).toContain("relation%3Asource");
  });
  it("keeps empty scores unrated and dates unknown", () => {
    const decoded = decodeIdea(page() as any);
    expect(decoded.priorityScore).toBeNull();
    expect(decoded.confidence).toBeNull();
    expect(decoded.lastReviewed).toBeNull();
  });
  it("rejects unsupported status values", () => {
    const p = props();
    p.Status.select.name = "Surprise";
    expect(() => decodeIdea(page({ properties: p }) as any)).toThrow(AppError);
  });
  it("chunks Unicode without splitting surrogate pairs", () => {
    const value = "🚀".repeat(2100),
      encoded = richText(value);
    expect(encoded.rich_text).toHaveLength(3);
    expect(encoded.rich_text.map((t) => t.text.content).join("")).toBe(value);
    expect(encoded.rich_text.every((t) => t.text.content.length <= 1900)).toBe(
      true,
    );
  });
  it("does not leak provider bodies or token on permission failure", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(new Response("private-secret-body", { status: 403 }));
    try {
      await new NotionRepository(config, request as typeof fetch).query(
        ids.ideas,
      );
    } catch (error) {
      expect(String(error)).not.toContain(config.token);
      expect(String(error)).not.toContain("private-secret-body");
      expect(error).toMatchObject({ code: "NOTION_ACCESS_DENIED" });
    }
  });
  it("returns rate timing without retrying writes", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(
        new Response("", { status: 429, headers: { "Retry-After": "75" } }),
      );
    await expect(
      new NotionRepository(config, request as typeof fetch).call(
        "pages",
        "POST",
        {},
      ),
    ).rejects.toMatchObject({ code: "NOTION_RATE_LIMITED", retryAfter: 75 });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("marks timed-out writes uncertain and never retries them", async () => {
    const request = vi
      .fn()
      .mockRejectedValue(new Error("private network data"));
    await expect(
      new NotionRepository(config, request as typeof fetch).call(
        "pages",
        "POST",
        {},
      ),
    ).rejects.toMatchObject({ uncertain: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("uses data-source parent and excludes scores, relations and trash from create properties", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(schema()))
      .mockResolvedValueOnce(Response.json(page()));
    await new NotionRepository(config, request as typeof fetch).write(
      input,
      "op",
      "owner",
    );
    const body = JSON.parse(request.mock.calls[1][1].body),
      p = props();
    expect(body.parent).toEqual({
      type: "data_source_id",
      data_source_id: ids.ideas,
    });
    expect(body.properties[p["Priority Score"].id]).toBeUndefined();
    expect(body.properties[p.Sources.id]).toBeUndefined();
    expect(body.in_trash).toBeUndefined();
    expect(
      body.properties[p["Record Version"].id].rich_text[0].text.content,
    ).toContain("created:op");
  });
  it("aborts updates when revision changes just before patch", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(Response.json(schema()))
      .mockResolvedValueOnce(Response.json(page()));
    await expect(
      new NotionRepository(config, request as typeof fetch).write(
        input,
        "op",
        "owner",
        ids.idea,
        "stale-revision",
      ),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("fails on schema drift before a write", async () => {
    const request = vi
      .fn()
      .mockResolvedValue(Response.json({ properties: {} }));
    await expect(
      new NotionRepository(config, request as typeof fetch).write(
        input,
        "op",
        "owner",
      ),
    ).rejects.toMatchObject({ code: "NOTION_SCHEMA_MISMATCH" });
    expect(request).toHaveBeenCalledTimes(1);
  });
});
