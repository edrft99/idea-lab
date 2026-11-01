import { describe, it, expect, vi } from "vitest";
import { NotionRepository } from "../lib/ideas/notion";
import { IdeaService } from "../lib/ideas/service";
import { Operations } from "../lib/ideas/operations";
import { AppError } from "../lib/ideas/errors";
import {
  importSourceSchema,
  sourceKey,
  sourceRevision,
} from "../lib/imports/provenance";
import { memoryDB, idea, input, config, ids, page } from "./fixtures";
const source = importSourceSchema.parse({
  system: "ChatGPT",
  conversationId: "synthetic-c",
  messageId: "m1",
  locator: "ChatGPT:synthetic-c/message/m1",
  originalUrl: null,
  conversationDate: null,
  adapterVersion: "chatgpt-mapping-v1",
  role: "user",
  evidence: "I want to create a sensor kit.",
});
function setup() {
  const m = memoryDB(),
    ops = new Operations(m.db);
  const repo = {
    get: vi.fn().mockResolvedValue(idea),
    findOperation: vi.fn().mockResolvedValue(null),
    importedSourceState: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(idea),
    importSource: vi.fn().mockResolvedValue({ id: ids.source }),
    manualSource: vi.fn(),
    hasManualSource: vi.fn().mockResolvedValue(false),
  };
  return {
    m,
    ops,
    repo,
    service: new IdeaService(repo as unknown as NotionRepository, ops),
  };
}
const command = { action: "create" as const, data: input, source };
describe("reviewed imported capture", () => {
  it("includes exact provenance in the review and locks stable source identity", async () => {
    const s = setup();
    const receipt = await s.service.prepare(command, "owner");
    expect(s.repo.write).not.toHaveBeenCalled();
    expect(s.repo.importSource).not.toHaveBeenCalled();
    expect(
      receipt.changes.find((c) => c.field === "Source provenance")?.after,
    ).toContain(source.evidence);
    const op = await s.ops.read(receipt.approvalToken, "owner");
    expect(op.target).toBe(await sourceKey(source));
    await s.service.execute(command, receipt.approvalToken, "owner");
    expect(s.repo.importSource).toHaveBeenCalledWith(idea, op.id, source);
    expect(s.repo.manualSource).not.toHaveBeenCalled();
    expect((await s.ops.read(receipt.approvalToken, "owner")).status).toBe(
      "done",
    );
    s.m.close();
  });
  it("rejects substituted source evidence and repeated/changed canonical source identities", async () => {
    const s = setup(),
      receipt = await s.service.prepare(command, "owner");
    await expect(
      s.service.execute(
        { ...command, source: { ...source, evidence: "Changed" } },
        receipt.approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    s.repo.importedSourceState.mockResolvedValue({
      source: { ideaIds: [ids.idea] },
      revision: await sourceRevision(source),
    } as never);
    await expect(s.service.prepare(command, "owner")).rejects.toMatchObject({
      code: "SOURCE_ALREADY_IMPORTED",
    });
    await expect(
      s.service.prepare(
        { ...command, source: { ...source, evidence: "Changed" } },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "SOURCE_REVISION_CHANGED" });
    expect(s.repo.write).not.toHaveBeenCalled();
    s.m.close();
  });
  it("serializes the same source across receipts even when proposed idea content differs", async () => {
    const s = setup(),
      other = { ...command, data: { ...input, title: "Alternative title" } };
    const a = await s.service.prepare(command, "owner"),
      b = await s.service.prepare(other, "owner");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    s.repo.write.mockImplementation(async () => {
      await gate;
      return idea;
    });
    const first = s.service.execute(command, a.approvalToken, "owner");
    // Wait for the first operation to claim its lock and reach the provider.
    await vi.waitFor(() => expect(s.repo.write).toHaveBeenCalledTimes(1));
    await expect(
      s.service.execute(other, b.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    s.repo.importSource.mockImplementation(async () => {
      s.repo.importedSourceState.mockResolvedValue({
        source: { ideaIds: [ids.idea] },
        revision: await sourceRevision(source),
      } as never);
      return { id: ids.source };
    });
    release();
    await first;
    await expect(
      s.service.execute(other, b.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "SOURCE_ALREADY_IMPORTED" });
    expect(s.repo.write).toHaveBeenCalledTimes(1);
    s.m.close();
  });
  it("retains the source lock when canonical provenance is only partially saved", async () => {
    const s = setup(),
      a = await s.service.prepare(command, "owner"),
      b = await s.service.prepare(
        { ...command, data: { ...input, title: "Different" } },
        "owner",
      );
    s.repo.importSource.mockRejectedValue(
      new AppError("NOTION_UNAVAILABLE", "source failure", 503),
    );
    await expect(
      s.service.execute(command, a.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    expect((await s.ops.read(a.approvalToken, "owner")).status).toBe(
      "uncertain",
    );
    await expect(
      s.service.execute(
        { ...command, data: { ...input, title: "Different" } },
        b.approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    s.repo.findOperation.mockResolvedValue(idea as never);
    expect((await s.service.reconcile(a.approvalToken, "owner")).status).toBe(
      "uncertain",
    );
    s.repo.hasManualSource.mockResolvedValue(true);
    expect((await s.service.reconcile(a.approvalToken, "owner")).status).toBe(
      "done",
    );
    s.m.close();
  });
});
describe("Notion source persistence", () => {
  const types: Record<string, string> = {
    Name: "title",
    "Source System": "select",
    "Source Identifier": "rich_text",
    "Original URL": "url",
    "Conversation Date": "date",
    "Captured Date": "date",
    "Extracted Summary": "rich_text",
    "Content Hash": "rich_text",
    "Import Batch": "rich_text",
    "Related Idea": "relation",
    "Source Key": "rich_text",
    "Source Revision": "rich_text",
    "Adapter Version": "rich_text",
    "Operation ID": "rich_text",
    "Processing Status": "select",
  };
  const schema = Object.fromEntries(
    Object.entries(types).map(([name, type], i) => [
      name,
      { id: "s" + i, type },
    ]),
  );
  it("writes stable source metadata and only selected redacted evidence", async () => {
    const writes: any[] = [];
    const fetcher = vi.fn(async (url: any, options: any) => {
      const target = String(url).replace("https://api.notion.com/v1/", "");
      if (target === "data_sources/" + ids.sources)
        return Response.json({ properties: schema });
      if (target.endsWith("/query"))
        return Response.json({ results: [], has_more: false });
      const body = JSON.parse(options.body);
      writes.push(body);
      const properties = Object.fromEntries(
        Object.entries(schema).map(([name, p]) => [
          name,
          { ...p, ...body.properties[p.id] },
        ]),
      );
      return Response.json(
        page({
          id: ids.source,
          parent: { type: "data_source_id", data_source_id: ids.sources },
          properties,
        }),
      );
    });
    const repo = new NotionRepository(config, fetcher);
    const saved = await repo.importSource(idea, "op", source);
    expect(saved.system).toBe("ChatGPT");
    expect(saved.summary).toBe(source.evidence);
    expect(saved.ideaIds).toEqual([idea.id]);
    expect(saved.conversationDate).toBeNull();
    const p = writes[0].properties;
    expect(p[schema["Source Key"].id].rich_text[0].text.content).toBe(
      await sourceKey(source),
    );
    expect(p[schema["Source Revision"].id].rich_text[0].text.content).toBe(
      await sourceRevision(source),
    );
    expect(p[schema["Operation ID"].id].rich_text[0].text.content).toBe("op");
    expect(writes).toHaveLength(1);
  });
  it("fails schema preflight and ambiguity before creating another source", async () => {
    const fetcher = vi.fn(async (url: any) => {
      if (String(url).endsWith("/query"))
        return Response.json({
          results: [
            page({
              parent: { type: "data_source_id", data_source_id: ids.sources },
            }),
            page({
              parent: { type: "data_source_id", data_source_id: ids.sources },
            }),
          ],
          has_more: false,
        });
      return Response.json({ properties: schema });
    });
    const repo = new NotionRepository(config, fetcher);
    await expect(repo.importedSourceState(source)).rejects.toMatchObject({
      code: "RECONCILIATION_REQUIRED",
    });
    const broken = { ...schema };
    delete broken["Original URL"];
    const missing = new NotionRepository(
      config,
      vi.fn(async () => Response.json({ properties: broken })),
    );
    await expect(missing.importedSourceState(source)).rejects.toMatchObject({
      code: "NOTION_SCHEMA_MISMATCH",
    });
  });
});
