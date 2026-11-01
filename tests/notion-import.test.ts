import { describe, it, expect, vi } from "vitest";
import {
  NotionSelectionReader,
  configuredImportBoundary,
  verifySelectedNotionSource,
} from "../lib/imports/notion-collector";
import {
  notionReference,
  notionSelectionSchema,
} from "../lib/imports/notion-model";
import {
  importSourceSchema,
  sourceKey,
  sourceRevision,
  sha256,
} from "../lib/imports/provenance";
import { makeProposal } from "../lib/imports/staging";
import { IdeaService } from "../lib/ideas/service";
import { Operations } from "../lib/ideas/operations";
import { NotionRepository } from "../lib/ideas/notion";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { config, ids, idea, input, memoryDB, page } from "./fixtures";
const pageId = "a0000000-0000-4000-8000-00000000000a",
  blockId = "b0000000-0000-4000-8000-00000000000b",
  toggleId = "c0000000-0000-4000-8000-00000000000c",
  nestedId = "d0000000-0000-4000-8000-00000000000d",
  collectionId = "e0000000-0000-4000-8000-00000000000e",
  databaseId = "f0000000-0000-4000-8000-00000000000f",
  hubId = "11000000-0000-4000-8000-000000000011",
  childId = "12000000-0000-4000-8000-000000000012",
  syncedId = "13000000-0000-4000-8000-000000000013";
const revision = "2026-10-31T10:00:00.000Z",
  workspace = { type: "workspace", workspace: true };
const rt = (text: string) => [
  { type: "text", plain_text: text, text: { content: text } },
];
const env = {
  NOTION_HUB_URL: "https://www.notion.so/" + hubId,
  NOTION_IDEAS_URL: "https://www.notion.so/21000000000040008000000000000021",
  NOTION_SOURCES_URL: "https://www.notion.so/22000000000040008000000000000022",
  NOTION_EVALUATIONS_URL:
    "https://www.notion.so/23000000000040008000000000000023",
  NOTION_REVIEWS_URL: "https://www.notion.so/24000000000040008000000000000024",
};
function block(
  id: string,
  type = "paragraph",
  parent: any = { type: "page_id", page_id: pageId },
  text = "An idea: a tool for reusable workshops.",
) {
  return {
    object: "block",
    id,
    type,
    parent,
    has_children: false,
    created_time: revision,
    last_edited_time: revision,
    [type]: { rich_text: rt(text) },
  };
}
function setup() {
  const p = {
    object: "page",
    id: pageId,
    parent: workspace,
    created_time: revision,
    last_edited_time: revision,
    url: "https://www.notion.so/" + pageId.replaceAll("-", ""),
    properties: {
      Title: {
        id: "title",
        type: "title",
        title: rt("Synthetic selected page"),
      },
      Notes: {
        id: "notes",
        type: "rich_text",
        rich_text: rt("Idea: a tool for workshop planning."),
      },
    },
  };
  const paragraph = block(blockId),
    toggle = { ...block(toggleId, "toggle"), has_children: true };
  const nested = block(
    nestedId,
    "paragraph",
    { type: "block_id", block_id: toggleId },
    "Nested idea evidence.",
  );
  const child = block(childId, "child_page"),
    synced = block(syncedId, "synced_block");
  const metas = new Map<string, any>([
    ["pages/" + pageId, p],
    ["blocks/" + blockId, paragraph],
    ["blocks/" + toggleId, toggle],
    ["blocks/" + nestedId, nested],
    [
      "data_sources/" + collectionId,
      {
        object: "data_source",
        id: collectionId,
        parent: { type: "database_id", database_id: databaseId },
        title: rt("Synthetic data source"),
      },
    ],
    [
      "databases/" + databaseId,
      { object: "database", id: databaseId, parent: workspace },
    ],
  ]);
  const children = new Map<string, any>([
    [
      pageId + ":",
      { results: [paragraph, toggle, child, synced], has_more: false },
    ],
    [toggleId + ":", { results: [nested], has_more: false }],
  ]);
  const propertyPages = new Map<string, any>();
  let query = {
    results: [
      {
        ...p,
        parent: { type: "data_source_id", data_source_id: collectionId },
      },
    ],
    has_more: false,
    next_cursor: null,
  };
  const calls: { path: string; method: string; body: any }[] = [];
  const transport = {
    config,
    call: vi.fn(async (path: string, method = "GET", body?: unknown) => {
      calls.push({ path, method, body });
      if (method !== "GET" && !path.split("?")[0].endsWith("/query"))
        throw new Error("Collector attempted a mutation");
      const u = new URL("https://api.notion.com/v1/" + path),
        route = u.pathname.replace("/v1/", "");
      if (route.endsWith("/query")) return structuredClone(query);
      const childMatch = route.match(/^blocks\/([^/]+)\/children$/);
      if (childMatch) {
        const result = children.get(
          childMatch[1] + ":" + (u.searchParams.get("start_cursor") ?? ""),
        );
        if (!result) throw new Error("Unexpected child read");
        return structuredClone(result);
      }
      const propMatch = route.match(/^pages\/([^/]+)\/properties\/(.+)$/);
      if (propMatch) {
        const result = propertyPages.get(
          decodeURIComponent(propMatch[2]) +
            ":" +
            (u.searchParams.get("start_cursor") ?? ""),
        );
        if (!result) {
          const prop = Object.values(p.properties).find(
            (v: any) => v.id === decodeURIComponent(propMatch[2]),
          ) as any;
          if (prop && ["title", "rich_text"].includes(prop.type))
            return structuredClone({
              results: prop[prop.type].map((part: any) => ({
                type: prop.type,
                [prop.type]: part,
              })),
              has_more: false,
            });
          throw new Error("Unexpected property read");
        }
        return structuredClone(result);
      }
      const result = metas.get(route);
      if (!result) throw new Error("Unexpected metadata read " + route);
      return structuredClone(result);
    }),
  };
  const reader = () => new NotionSelectionReader(transport, [hubId]);
  return {
    p,
    paragraph,
    toggle,
    nested,
    metas,
    children,
    propertyPages,
    calls,
    transport,
    reader,
    setQuery: (value: any) => (query = value),
  };
}
describe("selected Notion source boundaries", () => {
  it("normalizes supported references and refuses arbitrary URLs or path injection", () => {
    expect(
      notionReference(
        "https://www.notion.so/A-title-" +
          pageId.replaceAll("-", "") +
          "?v=anything",
      ),
    ).toBe(pageId);
    expect(notionReference(pageId.toUpperCase())).toBe(pageId);
    for (const bad of [
      "https://notion.so.evil.test/" + pageId,
      "http://www.notion.so/" + pageId,
      "https://localhost/" + pageId,
      "../../pages/" + pageId,
      "https://www.notion.so/workspace",
    ])
      expect(() => notionReference(bad)).toThrow();
    expect(
      notionSelectionSchema.safeParse({
        action: "page",
        reference: pageId,
        allowContentRead: false,
      }).success,
    ).toBe(false);
    expect(
      notionSelectionSchema.safeParse({
        action: "rows",
        dataSourceId: collectionId,
        pageIds: [pageId, pageId.toUpperCase()],
        allowContentRead: true,
      }).success,
    ).toBe(false);
  });
  it("fails closed when configured self-import boundaries are incomplete", () => {
    expect(() =>
      runWithIdeaRuntime({}, () => configuredImportBoundary()),
    ).toThrow();
    expect(
      runWithIdeaRuntime(env, () => configuredImportBoundary()),
    ).toHaveLength(5);
  });
  it.each([hubId, ids.ideas, ids.sources, ids.evaluations, ids.reviews])(
    "blocks Idea Lab identity %s before reading provider content",
    async (id) => {
      const s = setup();
      await expect(s.reader().pages([id], true)).rejects.toMatchObject({
        code: "NOTION_SELF_IMPORT",
      });
      expect(s.calls).toHaveLength(0);
    },
  );
  it("blocks Idea Lab descendants by ancestry before reading their children", async () => {
    const s = setup();
    s.p.parent = { type: "data_source_id", data_source_id: ids.ideas } as any;
    await expect(s.reader().pages([pageId], true)).rejects.toMatchObject({
      code: "NOTION_SELF_IMPORT",
    });
    expect(s.calls.map((c) => c.path)).toEqual(["pages/" + pageId]);
  });
  it("reads chosen text only, redacts before returning and does not follow pages, syncs or attachments", async () => {
    const s = setup();
    s.p.url =
      "https://www.notion.so/" +
      config.token +
      "-" +
      pageId.replaceAll("-", "");
    s.paragraph.paragraph.rich_text = rt(
      "Idea evidence " +
        config.token +
        " secret_123456789012345678901234 contact@example.test <script>untrusted()</script>",
    );
    const result = await s.reader().pages([pageId], false),
      conversation = result.conversations[0];
    expect(conversation.system).toBe("Notion");
    expect(conversation.turns.every((t) => t.role === "document")).toBe(true);
    expect(conversation.turns.find((t) => t.id === blockId)?.text).toContain(
      "[REDACTED]",
    );
    expect(JSON.stringify(result)).not.toContain(config.token);
    expect(JSON.stringify(result)).not.toContain("contact@example.test");
    expect(JSON.stringify(result)).toContain("<script>untrusted()</script>");
    expect(s.calls.some((c) => c.path.includes(toggleId + "/children"))).toBe(
      false,
    );
    expect(
      s.calls.some(
        (c) =>
          c.path.includes(childId + "/children") ||
          c.path.includes(syncedId + "/children"),
      ),
    ).toBe(false);
    expect(result.ignored).toBe(2);
    expect(result.warnings.join(" ")).toContain(
      "Nested blocks were not loaded",
    );
    expect(s.calls.every((c) => c.method === "GET")).toBe(true);
  });
  it("loads supported nested containers only after explicit selection and retains block links", async () => {
    const s = setup(),
      result = await s.reader().pages([pageId], true),
      conversation = result.conversations[0],
      turn = conversation.turns.find((t) => t.id === nestedId)!;
    expect(turn.text).toBe("Nested idea evidence.");
    expect(turn.originalUrl).toBe(s.p.url + "#" + nestedId.replaceAll("-", ""));
    const proposal = makeProposal(conversation, turn, turn.text);
    expect(proposal.source).toMatchObject({
      system: "Notion",
      role: "document",
      conversationId: pageId,
      messageId: nestedId,
      originRevision: revision,
    });
    expect(proposal.source.locator).toBe(
      "Notion:" + pageId + "/block/" + nestedId,
    );
    expect(proposal.source.originalUrl).toBe(turn.originalUrl);
  });
  it("paginates child blocks and rejects repeated cursors rather than returning partial results", async () => {
    const s = setup();
    s.children.set(pageId + ":", {
      results: [s.paragraph],
      has_more: true,
      next_cursor: "next",
    });
    s.children.set(pageId + ":next", { results: [s.toggle], has_more: false });
    expect(
      (await s.reader().pages([pageId], false)).conversations[0].turns.filter(
        (t) => !t.id.startsWith("property:"),
      ),
    ).toHaveLength(2);
    s.children.set(pageId + ":next", {
      results: [s.toggle],
      has_more: true,
      next_cursor: "next",
    });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_INVALID",
    });
  });
  it("paginates text/relation properties without following related pages or double-encoding property IDs", async () => {
    const s = setup();
    (s.p.properties as any).References = {
      id: "rel%3A",
      type: "relation",
      relation: [{ id: childId }],
      has_more: true,
    };
    (s.p.properties as any).Notes = {
      id: "notes",
      type: "rich_text",
      rich_text: rt("partial"),
    };
    s.propertyPages.set("rel::", {
      results: [{ type: "relation", relation: { id: childId } }],
      has_more: true,
      next_cursor: "second",
    });
    s.propertyPages.set("rel::second", {
      results: [{ type: "relation", relation: { id: syncedId } }],
      has_more: false,
    });
    s.propertyPages.set("notes:", {
      results: [
        { type: "rich_text", rich_text: { plain_text: "Complete text" } },
      ],
      has_more: false,
    });
    const result = await s.reader().pages([pageId], false);
    expect(
      result.conversations[0].turns.find((t) => t.id === "property:notes")
        ?.text,
    ).toBe("Complete text");
    expect(result.warnings.join(" ")).toContain("2 references");
    expect(s.calls.some((c) => c.path.includes("rel%3A?"))).toBe(true);
    expect(s.calls.some((c) => c.path.includes("%253A"))).toBe(false);
    expect(s.calls.some((c) => c.path === "pages/" + childId)).toBe(false);
  });
  it("lists one metadata page and reads bodies only for chosen rows in that same data source", async () => {
    const s = setup(),
      reader = s.reader(),
      rows = await reader.list(collectionId, null);
    expect(rows.rows.map((r) => r.id)).toEqual([pageId]);
    expect(rows.rows[0].title).toBe("Synthetic selected page");
    expect(s.calls.some((c) => c.path.includes("/children"))).toBe(false);
    expect(
      s.calls.find((c) => c.path.split("?")[0].endsWith("/query"))?.body,
    ).toEqual({
      page_size: 25,
      result_type: "page",
    });
    await expect(
      reader.pages([pageId], false, collectionId),
    ).rejects.toMatchObject({ code: "NOTION_SELECTION_CHANGED" });
    expect(s.calls.some((c) => c.path.includes("/children"))).toBe(false);
    s.p.parent = {
      type: "data_source_id",
      data_source_id: collectionId,
    } as any;
    const preview = await s.reader().pages([pageId], false, collectionId);
    expect(preview.conversations).toHaveLength(1);
  });
  it("rejects outside rows, different metadata IDs, missing revisions and unsupported ancestry", async () => {
    const s = setup();
    s.setQuery({ results: [s.p], has_more: false });
    await expect(s.reader().list(collectionId, null)).rejects.toMatchObject({
      code: "NOTION_IMPORT_INVALID",
    });
    s.metas.set("pages/" + pageId, { ...s.p, id: childId });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_INVALID",
    });
    s.metas.set("pages/" + pageId, { ...s.p, last_edited_time: undefined });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_INVALID",
    });
    s.metas.set("pages/" + pageId, { ...s.p, parent: { type: "unknown" } });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_BOUNDARY_UNKNOWN",
    });
  });
  it("rejects oversized text and a block returned outside the selected tree", async () => {
    const s = setup();
    s.paragraph.paragraph.rich_text = rt("x".repeat(50001));
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_LIMIT",
    });
    s.paragraph.paragraph.rich_text = rt("Idea");
    s.paragraph.parent = { type: "page_id", page_id: childId };
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_INVALID",
    });
  });
  it("does not return a mixed snapshot when the page changes during loading", async () => {
    const s = setup();
    const original = s.transport.call.getMockImplementation()!;
    s.transport.call.mockImplementation(async (path, method, body) => {
      const result = await original(path, method, body);
      if (path.startsWith("blocks/"))
        s.p.last_edited_time = "2026-10-31T11:00:00.000Z";
      return result;
    });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_SELECTION_CHANGED",
    });
  });
  it("verifies selected block/property revisions and rejects forged origin or moved blocks", async () => {
    const s = setup(),
      result = await s.reader().pages([pageId], true),
      c = result.conversations[0],
      turn = c.turns.find((t) => t.id === blockId)!;
    const source = makeProposal(c, turn, turn.text).source;
    await s.reader().verify(source);
    await expect(
      s
        .reader()
        .verify({ ...source, originalUrl: "https://example.test/fake" }),
    ).rejects.toMatchObject({ code: "NOTION_SOURCE_CHANGED" });
    s.paragraph.last_edited_time = "2026-10-31T11:00:00.000Z";
    await expect(s.reader().verify(source)).rejects.toMatchObject({
      code: "NOTION_SOURCE_CHANGED",
    });
    s.paragraph.last_edited_time = revision;
    s.metas.set("pages/" + childId, {
      ...s.p,
      id: childId,
      parent: { type: "page_id", page_id: pageId },
    });
    s.paragraph.parent = { type: "page_id", page_id: childId };
    await expect(s.reader().verify(source)).rejects.toMatchObject({
      code: "NOTION_SOURCE_CHANGED",
    });
    const property = makeProposal(
      c,
      c.turns.find((t) => t.id === "property:notes")!,
      "Selected notes",
    ).source;
    s.p.last_edited_time = "2026-10-31T11:00:00.000Z";
    await expect(s.reader().verify(property)).rejects.toMatchObject({
      code: "NOTION_SOURCE_CHANGED",
    });
  });
  it("preserves stable identities while external revisions change and old conversation hashes remain compatible", async () => {
    const s = setup(),
      result = await s.reader().pages([pageId], false),
      c = result.conversations[0],
      source = makeProposal(
        c,
        c.turns.find((t) => t.id === blockId)!,
        "Selected evidence",
      ).source;
    const normalized = importSourceSchema.parse({
      ...source,
      conversationId: pageId.toUpperCase(),
      messageId: blockId.toUpperCase(),
    });
    expect(await sourceKey(normalized)).toBe(await sourceKey(source));
    expect(
      await sourceRevision({
        ...source,
        originRevision: "2026-10-31T12:00:00.000Z",
      }),
    ).not.toBe(await sourceRevision(source));
    for (const bad of [
      { ...source, role: "assistant" },
      { ...source, originRevision: undefined },
      { ...source, messageId: "../../invalid" },
      { ...source, adapterVersion: "unknown" },
    ])
      expect(importSourceSchema.safeParse(bad).success).toBe(false);
    const chat = importSourceSchema.parse({
      ...source,
      system: "ChatGPT",
      role: "user",
      originRevision: undefined,
    });
    expect(await sourceRevision(chat)).toBe(
      await sha256(
        JSON.stringify([
          chat.role,
          chat.evidence,
          chat.conversationDate,
          chat.originalUrl,
          chat.locator,
          chat.adapterVersion,
        ]),
      ),
    );
  });
  it("checks Notion revisions again inside the write lock before any idea or source is created", async () => {
    const s = setup(),
      result = await s.reader().pages([pageId], false),
      c = result.conversations[0],
      source = makeProposal(
        c,
        c.turns.find((t) => t.id === blockId)!,
        "Selected evidence",
      ).source;
    const m = memoryDB();
    try {
      const ops = new Operations(m.db),
        repo = {
          ...s.transport,
          importedSourceState: vi.fn().mockResolvedValue(null),
          findOperation: vi.fn().mockResolvedValue(null),
          write: vi.fn().mockResolvedValue(idea),
          importSource: vi.fn(),
          get: vi.fn().mockResolvedValue(idea),
        };
      const service = new IdeaService(repo as any, ops),
        command = { action: "create" as const, data: input, source };
      const receipt = await runWithIdeaRuntime(env, () =>
        service.prepare(command, "owner"),
      );
      expect(
        receipt.changes.find((c) => c.field === "Source provenance")?.after,
      ).toContain("External revision: " + revision);
      s.paragraph.last_edited_time = "2026-10-31T12:00:00.000Z";
      await expect(
        runWithIdeaRuntime(env, () =>
          service.execute(command, receipt.approvalToken, "owner"),
        ),
      ).rejects.toMatchObject({ code: "NOTION_SOURCE_CHANGED" });
      expect(repo.write).not.toHaveBeenCalled();
      expect(repo.importSource).not.toHaveBeenCalled();
      expect((await ops.read(receipt.approvalToken, "owner")).status).toBe(
        "failed",
      );
    } finally {
      m.close();
    }
  });
  it("stores selected provenance and external revision in the approved Source body without changing the original", async () => {
    const s = setup(),
      result = await s.reader().pages([pageId], false),
      c = result.conversations[0],
      source = makeProposal(
        c,
        c.turns.find((t) => t.id === blockId)!,
        "Selected redacted evidence",
      ).source;
    const repo = new NotionRepository(config);
    vi.spyOn(repo, "schema").mockResolvedValue(
      Object.fromEntries(
        [
          "Name",
          "Source System",
          "Source Identifier",
          "Original URL",
          "Conversation Date",
          "Captured Date",
          "Extracted Summary",
          "Content Hash",
          "Import Batch",
          "Related Idea",
          "Source Key",
          "Source Revision",
          "Adapter Version",
          "Operation ID",
          "Processing Status",
        ].map((name) => [name, { id: name, type: "rich_text" }]),
      ),
    );
    vi.spyOn(repo, "importedSourceState").mockResolvedValue(null);
    const call = vi
      .spyOn(repo, "call")
      .mockImplementation(async (path, method, body: any) => {
        expect(path).toBe("pages");
        expect(method).toBe("POST");
        return page({
          id: ids.source,
          parent: { type: "data_source_id", data_source_id: ids.sources },
          properties: body.properties,
        });
      });
    await repo.importSource(idea, "a".repeat(64), source);
    const body = call.mock.calls[0][2] as any,
      snapshot = JSON.parse(
        body.children[0].code.rich_text
          .map((p: any) => p.text.content)
          .join(""),
      );
    expect(snapshot.source).toEqual(source);
    expect(snapshot.source.originRevision).toBe(revision);
    expect(body.properties["Source System"].select.name).toBe("Notion");
    expect(call).toHaveBeenCalledTimes(1);
  });
  it("checks ancestor page titles only and does not return ancestor properties", async () => {
    const s = setup();
    s.p.parent = { type: "page_id", page_id: childId } as any;
    s.metas.set("pages/" + childId, {
      ...s.p,
      id: childId,
      parent: workspace,
      properties: {
        Title: { id: "title", type: "title", title: rt("Ancestor metadata") },
        Private: {
          id: "private",
          type: "rich_text",
          rich_text: rt("Unselected ancestor private text"),
        },
      },
    });
    const result = await s.reader().pages([pageId], false);
    expect(
      s.calls.some(
        (c) => c.path === "pages/" + childId + "?filter_properties=title",
      ),
    ).toBe(true);
    expect(s.calls.some((c) => c.path === "pages/" + childId)).toBe(false);
    expect(JSON.stringify(result)).not.toContain(
      "Unselected ancestor private text",
    );
  });
  it("refuses cyclic ancestry before loading any child content", async () => {
    const s = setup();
    s.p.parent = { type: "page_id", page_id: childId } as any;
    s.metas.set("pages/" + childId, {
      ...s.p,
      id: childId,
      parent: { type: "page_id", page_id: pageId },
    });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_IMPORT_INVALID",
    });
    expect(s.calls.some((c) => c.path.includes("/children"))).toBe(false);
  });
  it("rejects a page archived during loading even if its revision does not change", async () => {
    const s = setup(),
      original = s.transport.call.getMockImplementation()!;
    s.transport.call.mockImplementation(async (path, method, body) => {
      const result = await original(path, method, body);
      if (path.startsWith("blocks/")) (s.p as any).in_trash = true;
      return result;
    });
    await expect(s.reader().pages([pageId], false)).rejects.toMatchObject({
      code: "NOTION_SELECTION_CHANGED",
    });
  });
  it("keeps a moved block's identity stable while separating page-local properties", async () => {
    const s = setup(),
      result = await s.reader().pages([pageId], false),
      c = result.conversations[0];
    const source = makeProposal(
      c,
      c.turns.find((t) => t.id === blockId)!,
      "Selected evidence",
    ).source;
    const moved = {
      ...source,
      conversationId: childId,
      locator: "Notion:" + childId + "/block/" + blockId,
      originalUrl:
        "https://www.notion.so/" +
        childId.replaceAll("-", "") +
        "#" +
        blockId.replaceAll("-", ""),
    };
    expect(await sourceKey(moved)).toBe(await sourceKey(source));
    expect(await sourceRevision(moved)).not.toBe(await sourceRevision(source));
    const property = makeProposal(
      c,
      c.turns.find((t) => t.id === "property:notes")!,
      "Selected notes",
    ).source;
    expect(await sourceKey({ ...property, conversationId: childId })).not.toBe(
      await sourceKey(property),
    );
    expect(
      await sourceKey({ ...property, messageId: "property:note%3A" }),
    ).toBe(await sourceKey({ ...property, messageId: "property:note:" }));
  });
});
