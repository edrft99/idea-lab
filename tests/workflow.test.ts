import { importSourceSchema } from "../lib/imports/provenance";
import { describe, it, expect, vi, afterEach } from "vitest";
import { NotionRepository } from "../lib/ideas/notion";
import { IdeaService } from "../lib/ideas/service";
import { Operations, digest } from "../lib/ideas/operations";
import { AppError } from "../lib/ideas/errors";
import {
  memoryDB,
  config,
  ids,
  input,
  idea,
  props,
  page,
  schema,
} from "./fixtures";
describe("complete approved capture against a mocked Notion provider", () => {
  it.each(["manual", "imported"])(
    "creates an idea and %s source, follows dual relations, then returns the confirmed canonical record",
    async (mode) => {
      const memory = memoryDB();
      let ideaRecord = page(),
        sourceRecord: any = null;
      const p = props(),
        sourceProps: Record<string, any> = {};
      for (const [n, name] of [
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
        "Adapter Version",
        "Operation ID",
        "Processing Status",
        "Source Revision",
      ].entries()) {
        const type =
          name === "Name"
            ? "title"
            : name === "Related Idea"
              ? "relation"
              : ["Captured Date", "Conversation Date"].includes(name)
                ? "date"
                : name === "Original URL"
                  ? "url"
                  : ["Source System", "Processing Status"].includes(name)
                    ? "select"
                    : "rich_text";
        sourceProps[name] = {
          id: "s" + n,
          type,
          ...(type === "relation"
            ? { relation: [] }
            : type === "select"
              ? { select: null }
              : type === "title"
                ? { title: [] }
                : type === "date"
                  ? { date: null }
                  : { rich_text: [] }),
        };
      }
      const sourceSchema = schema(sourceProps);
      const events: { method: string; path: string; body: any }[] = [];
      const request = vi.fn(
        async (url: string | URL | Request, options?: RequestInit) => {
          const path = String(url).replace("https://api.notion.com/v1/", ""),
            body = options?.body ? JSON.parse(String(options.body)) : null;
          events.push({ method: options?.method ?? "GET", path, body });
          if (path === "data_sources/" + ids.ideas)
            return Response.json(schema());
          if (path === "data_sources/" + ids.sources)
            return Response.json(sourceSchema);
          if (path === "data_sources/" + ids.ideas + "/query")
            return Response.json({
              results:
                body.filter &&
                ideaRecord.properties["Record Version"].rich_text.some(
                  (t: any) =>
                    (t.text?.content ?? t.plain_text ?? "").includes(
                      body.filter.rich_text.contains,
                    ),
                )
                  ? [ideaRecord]
                  : [],
              has_more: false,
              next_cursor: null,
            });
          if (path === "data_sources/" + ids.reviews + "/query")
            return Response.json({
              results: [],
              has_more: false,
              next_cursor: null,
            });
          if (path === "data_sources/" + ids.sources + "/query")
            return Response.json({
              results: sourceRecord ? [sourceRecord] : [],
              has_more: false,
              next_cursor: null,
            });
          if (path === "pages/" + ids.idea) return Response.json(ideaRecord);
          if (path === "pages" && body.parent.data_source_id === ids.ideas) {
            const named = { ...p };
            for (const [id, value] of Object.entries(body.properties)) {
              const name = Object.keys(p).find((n) => p[n].id === id)!;
              named[name] = { ...p[name], ...(value as object) };
            }
            ideaRecord = page({ properties: named });
            return Response.json(ideaRecord);
          }
          if (path === "pages" && body.parent.data_source_id === ids.sources) {
            const named = { ...sourceProps };
            for (const [id, value] of Object.entries(body.properties)) {
              const name = Object.keys(sourceProps).find(
                (n) => sourceProps[n].id === id,
              )!;
              named[name] = { ...sourceProps[name], ...(value as object) };
            }
            sourceRecord = page({
              id: ids.source,
              parent: { type: "data_source_id", data_source_id: ids.sources },
              properties: named,
            });
            ideaRecord.properties.Sources.relation = [{ id: ids.source }];
            return Response.json(sourceRecord);
          }
          throw new Error("Unexpected mocked request " + path);
        },
      );
      const repository = new NotionRepository(config, request as typeof fetch),
        operations = new Operations(memory.db),
        service = new IdeaService(repository, operations),
        command = {
          action: "create" as const,
          data: input,
          ...(mode === "imported"
            ? {
                source: importSourceSchema.parse({
                  system: "ChatGPT",
                  conversationId: "synthetic-workflow",
                  messageId: "m1",
                  locator: "ChatGPT:synthetic-workflow/message/m1",
                  originalUrl: null,
                  conversationDate: null,
                  adapterVersion: "chatgpt-mapping-v1",
                  role: "user",
                  evidence: "I want to build a portable sensor demo.",
                }),
              }
            : {}),
        };
      const approval = await service.prepare(command, "owner");
      expect(
        events.filter((e) => e.path === "pages" && e.method === "POST"),
      ).toHaveLength(0);
      const saved = await service.execute(
        command,
        approval.approvalToken,
        "owner",
      );
      expect(saved.idea.sources).toHaveLength(1);
      expect(saved.idea.sources[0].system).toBe(
        mode === "manual" ? "Manual" : "ChatGPT",
      );
      expect(saved.idea.sources[0].conversationDate).toBeNull();
      expect(saved.idea.sourceIds).toEqual([ids.source]);
      expect(
        events.filter((e) => e.path === "pages" && e.method === "POST"),
      ).toHaveLength(2);
      expect(
        events.find(
          (e) =>
            e.path === "pages" && e.body.parent.data_source_id === ids.sources,
        )!.body.properties[sourceProps["Related Idea"].id],
      ).toEqual({ relation: [{ id: ids.idea }] });
      expect(
        (await service.execute(command, approval.approvalToken, "owner"))
          .replayed,
      ).toBe(true);
      expect(
        events.filter((e) => e.path === "pages" && e.method === "POST"),
      ).toHaveLength(2);
      if (mode === "imported") {
        await expect(service.prepare(command, "owner")).rejects.toMatchObject({
          code: "SOURCE_ALREADY_IMPORTED",
        });
        expect(
          events.filter((e) => e.path === "pages" && e.method === "POST"),
        ).toHaveLength(2);
      }
      memory.close();
    },
  );
  it("can recover the result after a page reload without retaining the raw approval token", async () => {
    const memory = memoryDB(),
      ops = new Operations(memory.db);
    const repo = {
      get: vi.fn().mockResolvedValue(idea),
      findOperation: vi.fn().mockResolvedValue(null),
      write: vi
        .fn()
        .mockRejectedValue(
          new AppError("WRITE_UNCERTAIN", "uncertain", 503, undefined, true),
        ),
      manualSource: vi.fn(),
      hasManualSource: vi.fn().mockResolvedValue(true),
    };
    const first = new IdeaService(repo as unknown as NotionRepository, ops),
      command = { action: "create" as const, data: input },
      approval = await first.prepare(command, "owner");
    await expect(
      first.execute(command, approval.approvalToken, "owner"),
    ).rejects.toThrow();
    repo.findOperation.mockResolvedValue(idea);
    const savedOperations = await new Operations(memory.db).recent("owner");
    expect(savedOperations).toHaveLength(1);
    const operationId = String(savedOperations[0].id);
    const afterReload = new IdeaService(
      repo as unknown as NotionRepository,
      new Operations(memory.db),
    );
    expect(await afterReload.reconcileId(operationId, "owner")).toEqual({
      status: "done",
      ideaId: idea.id,
    });
    expect(repo.write).toHaveBeenCalledTimes(1);
    await expect(
      afterReload.reconcileId(operationId, "someone-else"),
    ).rejects.toMatchObject({ status: 403 });
    memory.close();
  });
  it("lists no operations for a different actor", async () => {
    const m = memoryDB(),
      ops = new Operations(m.db);
    await ops.issue("owner", await digest("payload"), "create", null, null);
    expect(await ops.recent("other")).toHaveLength(0);
    m.close();
  });
});
