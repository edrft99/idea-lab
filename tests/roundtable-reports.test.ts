import type { GrokConfig } from "../lib/roundtable/grok-config";
import type { ClaudeConfig } from "../lib/roundtable/claude-config";
import {
  RoundtableService,
  roundtableRequestStatus,
} from "../lib/roundtable/service";
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
async function setup(participant: "gpt" | "claude" | "grok" = "gpt") {
  const memory = memoryDB(),
    ops = new Operations(memory.db),
    rows: any[] = [],
    calls: { path: string; method: string; body: any }[] = [];
  let loseResponse = false,
    rejectNext = false;
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
      if (rejectNext) {
        rejectNext = false;
        return Response.json(
          {
            code: "validation_error",
            message: "Synthetic rejection before mutation",
          },
          { status: 400 },
        );
      }
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
    "roundtable-" + participant,
    idea.id,
    "config-hash",
  );
  const result = resultSchema.parse({
    format: "idea-lab-roundtable",
    version: 1,
    runId: source.id,
    participant,
    stage: "independent",
    input: roundtableCommand,
    inputHash: await digest(JSON.stringify(roundtableCommand)),
    assessment,
    provider:
      participant === "grok"
        ? "xai-chat-completions"
        : participant === "claude"
          ? "anthropic-messages"
          : gptConfig.provider,
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
    reject: () => {
      rejectNext = true;
    },
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

async function automaticSetup() {
  const state = await setup();
  const provider = {
    evaluate: vi.fn().mockResolvedValue({
      value: assessment,
      resolvedModel: "synthetic-gpt-resolved",
      responseId: "synthetic-response",
      usage: null,
    }),
  };
  const generation = new RoundtableService(
    gptConfig,
    state.repo,
    state.ops,
    provider,
    state.service,
  );
  return { ...state, provider, generation };
}
describe("automatic storage within the GPT request", () => {
  it("stores before returning without another save approval and recovers the report without replaying GPT", async () => {
    const { generation, service, provider, calls, ops } =
      await automaticSetup();
    const approval = await generation.prepare(roundtableCommand, "owner");
    expect(approval.profile.autoSaveReport).toBe(true);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(0);
    const generated = await generation.execute(
      roundtableCommand,
      approval.approvalToken,
      "owner",
    );
    expect(generated.storage.status).toBe("saved");
    if (generated.storage.status !== "saved")
      throw new Error("Missing automatic save");
    expect(generated.storage.report.snapshot.storageMode).toBe("automatic");
    expect(generated.storage.report.snapshot.result).toEqual(generated.result);
    const replay = await generation.execute(
      roundtableCommand,
      approval.approvalToken,
      "owner",
    );
    expect(replay.result).toEqual(generated.result);
    const recovered = await roundtableRequestStatus(
      ops,
      approval.approvalToken,
      "owner",
      service,
    );
    expect(recovered.resultRetained).toBe(true);
    expect(recovered).toMatchObject({ result: generated.result });
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
  });
  it("returns GPT output when a Notion response is lost and reconciles storage without regenerating", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { generation, service, provider, calls, lose, ops } =
      await automaticSetup();
    const approval = await generation.prepare(roundtableCommand, "owner");
    lose();
    const generated = await generation.execute(
      roundtableCommand,
      approval.approvalToken,
      "owner",
    );
    expect(generated.result.assessment).toEqual(assessment);
    expect(generated.storage.status).toBe("uncertain");
    expect((await ops.read(approval.approvalToken, "owner")).status).toBe(
      "done",
    );
    expect((await service.recover(generated.result, "owner")).status).toBe(
      "done",
    );
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
  });
  it("retries only storage after a definitive rejection", async () => {
    const { generation, service, provider, calls, reject } =
      await automaticSetup();
    const approval = await generation.prepare(roundtableCommand, "owner");
    reject();
    const generated = await generation.execute(
      roundtableCommand,
      approval.approvalToken,
      "owner",
    );
    expect(generated.storage.status).toBe("failed");
    const saved = await service.autoSave(generated.result, "owner");
    expect(saved.status).toBe("saved");
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(2);
  });
  it("keeps a completed report as historical evidence if the idea changes while GPT is working", async () => {
    const { generation, provider, repo } = await automaticSetup();
    const approval = await generation.prepare(roundtableCommand, "owner");
    provider.evaluate.mockImplementation(async () => {
      vi.mocked(repo.get).mockResolvedValue({
        ...idea,
        revision: "changed-during-generation",
      });
      return {
        value: assessment,
        resolvedModel: "synthetic-gpt-resolved",
        responseId: "synthetic-response",
        usage: null,
      };
    });
    const generated = await generation.execute(
      roundtableCommand,
      approval.approvalToken,
      "owner",
    );
    expect(generated.storage.status).toBe("saved");
    expect(generated.result.input.inputRevision).toBe(idea.revision);
  });
  it("does not automatically save forged model output", async () => {
    const { service, result, calls } = await automaticSetup();
    const saved = await service.autoSave(
      { ...result, assessment: { ...result.assessment, summary: "Forged" } },
      "owner",
    );
    expect(saved.status).toBe("failed");
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(0);
  });
});

describe("automatic save recovery after a reload", () => {
  it("releases a confirmed save’s lock when history is loaded after a lost response", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { generation, service, lose, ops } = await automaticSetup();
    const approval = await generation.prepare(roundtableCommand, "owner");
    lose();
    const generated = await generation.execute(
      roundtableCommand,
      approval.approvalToken,
      "owner",
    );
    if (
      generated.storage.status !== "uncertain" ||
      !generated.storage.operationId
    )
      throw new Error("Expected interrupted storage");
    expect(
      (await ops.readById(generated.storage.operationId, "owner")).status,
    ).toBe("uncertain");
    expect(await service.list(idea.id, "owner")).toHaveLength(1);
    expect(
      (await ops.readById(generated.storage.operationId, "owner")).status,
    ).toBe("done");
    const edit = await ops.issue(
      "owner",
      "edit-hash",
      "update",
      idea.id,
      idea.revision,
    );
    expect(
      await ops.claim(await ops.read(edit.token, "owner"), "edit-hash"),
    ).toBe(true);
  });
});

describe("automatic storage coordination", () => {
  it("waits for an existing idea edit and then saves the same result without another model call", async () => {
    const { service, result, ops, calls } = await setup();
    const edit = await ops.issue(
      "owner",
      "edit-hash",
      "update",
      idea.id,
      idea.revision,
    );
    await ops.claim(await ops.read(edit.token, "owner"), "edit-hash");
    expect((await service.autoSave(result, "owner")).status).toBe("failed");
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(0);
    await ops.finish(edit.id, "failed");
    expect((await service.autoSave(result, "owner")).status).toBe("saved");
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
  });
});

describe("Claude report storage and generation", () => {
  const claude: ClaudeConfig = {
    ...gptConfig,
    provider: "anthropic-messages",
    endpoint: "https://api.anthropic.com/v1/",
    deployment: "synthetic-claude",
  };
  it("generates once, automatically saves Claude’s scores and recovers them without another dispatch", async () => {
    const { service, repo, ops, calls } = await setup("claude");
    const provider = {
      evaluate: vi.fn().mockResolvedValue({
        value: assessment,
        resolvedModel: "synthetic-claude",
        responseId: "msg_synthetic",
        usage: null,
      }),
    };
    const generation = new RoundtableService(
      claude,
      repo,
      ops,
      provider,
      service,
    );
    const receipt = await generation.prepare(roundtableCommand, "owner");
    const response = await generation.execute(
      receipt.command,
      receipt.approvalToken,
      "owner",
    );
    expect(response.result.participant).toBe("claude");
    expect(response.result.input).toEqual(roundtableCommand);
    expect(response.storage.status).toBe("saved");
    expect((await ops.read(receipt.approvalToken, "owner")).action).toBe(
      "roundtable-claude",
    );
    expect(await ops.countAIAttempts("owner", 0)).toBe(2);
    expect(
      (await new RoundtableReportService(repo, ops).list(idea.id, "owner"))[0]
        .snapshot.result,
    ).toEqual(response.result);
    expect(
      (
        await generation.execute(
          receipt.command,
          receipt.approvalToken,
          "owner",
        )
      ).result,
    ).toEqual(response.result);
    expect(
      (
        await roundtableRequestStatus(
          ops,
          receipt.approvalToken,
          "owner",
          service,
        )
      ).result,
    ).toEqual(response.result);
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
    const gpt = new RoundtableService(gptConfig, repo, ops, provider, service);
    await expect(
      gpt.execute(receipt.command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
  });
  it("reconciles an uncertain Claude save without repeating the write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, result, lose, calls } = await setup("claude");
    lose();
    expect((await service.autoSave(result, "owner")).status).toBe("uncertain");
    expect((await service.recover(result, "owner")).status).toBe("done");
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
  });
  it("rejects relabeling a GPT run as a Claude result", async () => {
    const { service, result } = await setup();
    expect(
      (
        await service.autoSave(
          { ...result, participant: "claude", provider: "anthropic-messages" },
          "owner",
        )
      ).status,
    ).toBe("failed");
  });
});

describe("Grok report storage and generation", () => {
  const grok: GrokConfig = {
    ...gptConfig,
    provider: "xai-chat-completions",
    endpoint: "https://api.x.ai/v1/",
    deployment: "synthetic-grok",
  };
  it("generates once, automatically saves Grok’s scores and recovers them without another dispatch", async () => {
    const { service, repo, ops, calls } = await setup("grok");
    const provider = {
      evaluate: vi.fn().mockResolvedValue({
        value: assessment,
        resolvedModel: "synthetic-grok",
        responseId: "msg_synthetic",
        usage: null,
      }),
    };
    const generation = new RoundtableService(
      grok,
      repo,
      ops,
      provider,
      service,
    );
    const receipt = await generation.prepare(roundtableCommand, "owner");
    const response = await generation.execute(
      receipt.command,
      receipt.approvalToken,
      "owner",
    );
    expect(response.result.participant).toBe("grok");
    expect(response.result.input).toEqual(roundtableCommand);
    expect(response.storage.status).toBe("saved");
    expect((await ops.read(receipt.approvalToken, "owner")).action).toBe(
      "roundtable-grok",
    );
    expect(await ops.countAIAttempts("owner", 0)).toBe(2);
    expect(
      (await new RoundtableReportService(repo, ops).list(idea.id, "owner"))[0]
        .snapshot.result,
    ).toEqual(response.result);
    expect(
      (
        await generation.execute(
          receipt.command,
          receipt.approvalToken,
          "owner",
        )
      ).result,
    ).toEqual(response.result);
    expect(
      (
        await roundtableRequestStatus(
          ops,
          receipt.approvalToken,
          "owner",
          service,
        )
      ).result,
    ).toEqual(response.result);
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
    const gpt = new RoundtableService(gptConfig, repo, ops, provider, service);
    await expect(
      gpt.execute(receipt.command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
  });
  it("reconciles an uncertain Grok save without repeating the write", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { service, result, lose, calls } = await setup("grok");
    lose();
    expect((await service.autoSave(result, "owner")).status).toBe("uncertain");
    expect((await service.recover(result, "owner")).status).toBe("done");
    expect(calls.filter((c) => c.path === "pages")).toHaveLength(1);
  });
  it("rejects relabeling a GPT run as a Grok result", async () => {
    const { service, result } = await setup();
    expect(
      (
        await service.autoSave(
          { ...result, participant: "grok", provider: "xai-chat-completions" },
          "owner",
        )
      ).status,
    ).toBe("failed");
  });
});
