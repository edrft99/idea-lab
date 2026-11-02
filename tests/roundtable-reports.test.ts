import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RoundtableReports,
  RoundtableReportService,
} from "../lib/roundtable/reports";
import { resultSchema } from "../lib/roundtable/model";
import { Operations, digest } from "../lib/ideas/operations";
import { memoryDB, idea, config, page, ids } from "./fixtures";
import {
  assessment,
  gptConfig,
  roundtableCommand,
} from "./roundtable-fixtures";
import { reviewTypes } from "../lib/proposals/repository";
afterEach(() => vi.restoreAllMocks());
async function setup() {
  const memory = memoryDB(),
    ops = new Operations(memory.db),
    rows: any[] = [],
    calls: { path: string; method: string; body: any }[] = [];
  let loseResponse = false;
  const props = Object.fromEntries(
    Object.entries(reviewTypes).map(([name, type], n) => [
      name,
      { id: "r" + n, type },
    ]),
  );
  const fetcher = vi.fn(async (url: any, options: any) => {
    const path = String(url).replace("https://api.notion.com/v1/", ""),
      body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path, method: options.method, body });
    if (path === "data_sources/" + ids.reviews)
      return Response.json({ properties: props });
    if (path === "data_sources/" + ids.reviews + "/query")
      return Response.json({
        results: rows,
        has_more: false,
        next_cursor: null,
      });
    if (path === "pages" && options.method === "POST") {
      const mapped = Object.fromEntries(
        Object.entries(body.properties).map(([id, value]) => [
          Object.keys(props).find((name) => props[name].id === id)!,
          value,
        ]),
      );
      const row = page({
        id: "70000000-0000-4000-8000-000000000007",
        parent: { type: "data_source_id", data_source_id: ids.reviews },
        properties: mapped,
      });
      rows.push(row);
      if (loseResponse)
        throw new Error("Lost response after Notion accepted the write");
      return Response.json(row);
    }
    throw new Error("Unexpected synthetic request: " + path);
  });
  const repo = new RoundtableReports(config, fetcher);
  vi.spyOn(repo, "get").mockResolvedValue(idea);
  const service = new RoundtableReportService(repo, ops);
  const source = await ops.issue(
    "owner",
    await digest(JSON.stringify(roundtableCommand)),
    "roundtable-gpt",
    idea.id,
    "config-hash",
  );
  const result = resultSchema.parse({
    format: "idea-lab-roundtable",
    version: 1,
    runId: source.id,
    participant: "gpt",
    stage: "independent",
    input: roundtableCommand,
    inputHash: await digest(JSON.stringify(roundtableCommand)),
    assessment,
    provider: gptConfig.provider,
    model: gptConfig.deployment,
    resolvedModel: "synthetic-gpt-resolved",
    endpoint: gptConfig.endpoint,
    responseId: "synthetic-response",
    rubricVersion: "viability-v1",
    promptVersion: "roundtable-independent-v1",
    requestedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    usage: null,
  });
  await ops.finishRoundtableRequest(
    source.id,
    "done",
    await digest(JSON.stringify(result)),
  );
  return {
    repo,
    service,
    ops,
    result,
    rows,
    calls,
    lose: () => {
      loseResponse = true;
    },
  };
}
describe("durable reviewed roundtable reports", () => {
  it("prepares without writing, saves the complete report once, and loads it in a fresh service", async () => {
    const { service, repo, ops, result, calls } = await setup();
    const approval = await service.prepare(result, "owner");
    expect(
      calls.filter((c) => c.method === "POST" && c.path === "pages"),
    ).toHaveLength(0);
    expect("approvalToken" in approval).toBe(true);
    const { report } = await service.commit(
      result,
      (approval as any).approvalToken,
      "owner",
    );
    expect(report.snapshot.result).toEqual(result);
    expect(
      (await new RoundtableReportService(repo, ops).list(idea.id, "owner"))[0],
    ).toEqual(report);
    await service.commit(result, (approval as any).approvalToken, "owner");
    expect(await service.prepare(result, "owner")).toMatchObject({ report });
    const writes = calls.filter(
      (c) => c.path === "pages" && c.method === "POST",
    );
    expect(writes).toHaveLength(1);
    expect(writes[0].body.parent.data_source_id).toBe(ids.reviews);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    expect(JSON.stringify(writes[0].body)).not.toContain("Priority Score");
  });
  it("deduplicates two approvals for the same GPT run", async () => {
    const { service, result, calls } = await setup();
    const a = await service.prepare(result, "owner"),
      b = await service.prepare(result, "owner");
    const first = await service.commit(
      result,
      (a as any).approvalToken,
      "owner",
    );
    const second = await service.commit(
      result,
      (b as any).approvalToken,
      "owner",
    );
    expect(second.report.id).toBe(first.report.id);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
    expect(
      (await service.reconcile(await digest((b as any).approvalToken), "owner"))
        .status,
    ).toBe("done");
  });
  it("rejects forged or modified GPT output and a different actor", async () => {
    const { service, result, calls } = await setup();
    await expect(
      service.prepare(
        {
          ...result,
          assessment: { ...result.assessment, summary: "Changed result" },
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "AI_PROVENANCE_INVALID" });
    await expect(service.prepare(result, "other")).rejects.toMatchObject({
      code: "INVALID_OPERATION",
    });
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(0);
  });
  it("checks the current idea before approval and again before writing", async () => {
    const { service, repo, result, calls } = await setup();
    const approval = await service.prepare(result, "owner");
    vi.mocked(repo.get).mockResolvedValue({ ...idea, revision: "changed" });
    await expect(
      service.commit(result, (approval as any).approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    await expect(service.prepare(result, "owner")).rejects.toMatchObject({
      code: "STALE_IDEA",
    });
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(0);
  });
  it("rejects edited and expired save approvals", async () => {
    const { service, result } = await setup();
    const approval = await service.prepare(result, "owner");
    await expect(
      service.commit(
        { ...result, model: "different-model" },
        (approval as any).approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
    await expect(
      service.commit(result, (approval as any).approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
  });
  it("recovers an accepted write after a lost response without sending it again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, result, ops, calls, lose } = await setup();
    const approval = await service.prepare(result, "owner");
    lose();
    await expect(
      service.commit(result, (approval as any).approvalToken, "owner"),
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      service.commit(result, (approval as any).approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(
      (await ops.read((approval as any).approvalToken, "owner")).status,
    ).toBe("uncertain");
    const recovered = await service.reconcile(
      await digest((approval as any).approvalToken),
      "owner",
    );
    expect(recovered.status).toBe("done");
    expect(recovered.report?.snapshot.result).toEqual(result);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
    expect(await service.list(idea.id, "owner")).toHaveLength(1);
  });
  it("rejects tampered Notion snapshots on reload", async () => {
    const { service, result, rows } = await setup();
    const approval = await service.prepare(result, "owner");
    await service.commit(result, (approval as any).approvalToken, "owner");
    rows[0].properties["Pair Key"] = {
      rich_text: [{ text: { content: "roundtable:tampered" } }],
    };
    await expect(service.list(idea.id, "owner")).rejects.toMatchObject({
      code: "ROUNDTABLE_REPORT_INVALID",
    });
  });
});
