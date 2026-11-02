import { describe, it, expect, vi, afterEach } from "vitest";
import {
  RoundtableService,
  roundtableRequestStatus,
} from "../lib/roundtable/service";
import { GPTReviewer } from "../lib/roundtable/provider";
import {
  provisionalScore,
  assessmentSchema,
  decodeResult,
} from "../lib/roundtable/model";
import { checkedOpenAIConfig } from "../lib/intelligence/openai-config";
import { NotionRepository } from "../lib/ideas/notion";
import { Operations, digest } from "../lib/ideas/operations";
import { memoryDB, idea, config } from "./fixtures";
import { aiConfig } from "./ai-fixtures";
import {
  gptConfig,
  roundtableCommand as command,
  assessment,
  responseBody,
} from "./roundtable-fixtures";
afterEach(() => vi.restoreAllMocks());
function setup(overrides = {}) {
  const db = memoryDB(),
    ops = new Operations(db.db),
    repo = new NotionRepository(config);
  vi.spyOn(repo, "get").mockResolvedValue(idea);
  const provider = {
    evaluate: vi.fn().mockResolvedValue({
      value: assessment,
      resolvedModel: "synthetic-gpt-resolved",
      responseId: "synthetic-response",
      usage: null,
    }),
  };
  const service = new RoundtableService(
    { ...gptConfig, ...overrides },
    repo,
    ops,
    provider,
  );
  return { service, provider, repo, ops, db };
}
describe("roundtable GPT first reviewer", () => {
  it("prepares without a provider call, dispatches once, computes scores outside the model and retains only hashes", async () => {
    const { service, provider, ops } = setup();
    const receipt = await service.prepare(command, "owner");
    expect(provider.evaluate).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toContain(gptConfig.key);
    const { result } = await service.execute(
      command,
      receipt.approvalToken,
      "owner",
    );
    expect(result.participant).toBe("gpt");
    expect(result.stage).toBe("independent");
    expect(provisionalScore(result.assessment)).toBe(57);
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    const op = await ops.read(receipt.approvalToken, "owner");
    expect(op.result_id).toBe(await digest(JSON.stringify(result)));
    expect(JSON.stringify(op)).not.toContain(command.selection.summary);
    await expect(
      service.execute(command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "AI_RESULT_NOT_RETAINED" });
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    expect(
      (await roundtableRequestStatus(ops, receipt.approvalToken, "owner"))
        .status,
    ).toBe("done");
    expect(decodeResult(JSON.stringify(result))).toEqual(result);
  });
  it("rejects changed content, a different owner and stale ideas before dispatch", async () => {
    const { service, provider, repo } = setup();
    const receipt = await service.prepare(command, "owner");
    await expect(
      service.execute(
        { ...command, constraints: "A different set of constraints." },
        receipt.approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    await expect(
      service.execute(command, receipt.approvalToken, "other"),
    ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
    vi.mocked(repo.get).mockResolvedValue({ ...idea, revision: "changed" });
    await expect(
      service.execute(command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    expect(provider.evaluate).not.toHaveBeenCalled();
  });
  it("binds approval to model, policy and credentials", async () => {
    const { service, provider, repo, ops } = setup();
    const receipt = await service.prepare(command, "owner");
    for (const change of [
      { key: "rotated-key" },
      { deployment: "other-model" },
      { retentionNotice: "Other service policy" },
    ]) {
      const changed = new RoundtableService(
        { ...gptConfig, ...change },
        repo,
        ops,
        provider,
      );
      await expect(
        changed.execute(command, receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    }
    expect(provider.evaluate).not.toHaveBeenCalled();
  });
  it("rejects expired approval", async () => {
    const { service, provider } = setup();
    const receipt = await service.prepare(command, "owner");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
    await expect(
      service.execute(command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    expect(provider.evaluate).not.toHaveBeenCalled();
  });
  it("shares the hourly model request budget", async () => {
    const { service, provider, ops } = setup({ requestsPerHour: 1 });
    const prior = await ops.issue(
      "owner",
      "hash",
      "ai-evaluate",
      "other-idea",
      null,
    );
    await ops.finish(prior.id, "failed");
    const receipt = await service.prepare(command, "owner");
    await expect(
      service.execute(command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "AI_BUDGET_EXHAUSTED" });
    expect(provider.evaluate).not.toHaveBeenCalled();
  });
  it("retains uncertain dispatch status and never retries a lost response", async () => {
    const { service, provider, ops } = setup();
    provider.evaluate.mockRejectedValue(new Error("Connection lost"));
    const receipt = await service.prepare(command, "owner");
    await expect(
      service.execute(command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ uncertain: true });
    expect(
      (await roundtableRequestStatus(ops, receipt.approvalToken, "owner"))
        .status,
    ).toBe("uncertain");
    await expect(
      service.execute(command, receipt.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(provider.evaluate).toHaveBeenCalledTimes(1);
    const ordinaryEdit = await ops.issue(
      "owner",
      "edit-hash",
      "update",
      command.ideaId,
      command.inputRevision,
    );
    expect(
      await ops.claim(await ops.read(ordinaryEdit.token, "owner"), "edit-hash"),
    ).toBe(true);
    await ops.finish(ordinaryEdit.id, "failed");
    provider.evaluate.mockResolvedValue({
      value: assessment,
      resolvedModel: "synthetic-gpt-resolved",
      responseId: "new-synthetic-response",
      usage: null,
    });
    const fresh = await service.prepare(command, "owner");
    await service.execute(command, fresh.approvalToken, "owner");
    expect(provider.evaluate).toHaveBeenCalledTimes(2);
  });
  it("redacts selected excerpts and constraints before exact-content review", async () => {
    const { service } = setup();
    const receipt = await service.prepare(
      {
        ...command,
        constraints: "Never transmit " + gptConfig.key,
        selection: { summary: "Contact user@example.test for details." },
      },
      "owner",
    );
    expect(JSON.stringify(receipt.command)).not.toContain(gptConfig.key);
    expect(JSON.stringify(receipt.command)).not.toContain("user@example.test");
  });
  it("leaves scores unknown when evidence is insufficient", () => {
    expect(
      provisionalScore({
        ...assessment,
        ratings: {
          ...assessment.ratings,
          success: { score: null, evidence: "No success outcome evidence." },
        },
      }),
    ).toBeNull();
    expect(
      assessmentSchema.safeParse({ ...assessment, approved: true }).success,
    ).toBe(false);
    expect(() => decodeResult("x".repeat(100001))).toThrow();
  });
});
describe("documented GPT Responses transport", () => {
  it.each(["openai", "azure"])(
    "uses %s authentication and sends only selected evidence and rubric",
    async (provider) => {
      const fetcher = vi.fn().mockResolvedValue(Response.json(responseBody()));
      const result = await new GPTReviewer(
        provider === "openai" ? gptConfig : aiConfig,
        fetcher,
      ).evaluate(command);
      expect(result.value).toEqual(assessment);
      const [url, options] = fetcher.mock.calls[0];
      expect(url).toBe(
        (provider === "openai" ? gptConfig : aiConfig).endpoint + "responses",
      );
      expect(options.headers).toMatchObject(
        provider === "openai"
          ? { Authorization: "Bearer " + gptConfig.key }
          : { "api-key": aiConfig.key },
      );
      const body = JSON.parse(options.body);
      expect(body.store).toBe(false);
      expect(body.tools).toEqual([]);
      expect(body.text.format.strict).toBe(true);
      const sent = JSON.parse(body.input[0].content);
      expect(sent.selectedEvidence).toEqual(command.selection);
      expect(sent.successCriteria).toBe(command.successCriteria);
      expect(sent.ideaId).toBeUndefined();
      expect(sent.inputRevision).toBeUndefined();
      expect(sent.peers).toBeUndefined();
    },
  );
  it.each([
    "redirect",
    "refusal",
    "tools",
    "incomplete",
    "invalid",
    "huge",
    "network",
  ])("rejects %s without retry", async (mode) => {
    let body: any = responseBody();
    if (mode === "refusal")
      body.output[0].content = [{ type: "refusal", refusal: "Cannot assess" }];
    if (mode === "tools") body.output = [{ type: "function_call" }];
    if (mode === "incomplete") body.status = "incomplete";
    if (mode === "invalid") body = responseBody({ ...assessment, ratings: {} });
    const fetcher = vi.fn().mockImplementation(async () => {
      if (mode === "network") throw new Error("Disconnected");
      if (mode === "redirect")
        return new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.test" },
        });
      return Response.json(
        body,
        mode === "huge"
          ? { headers: { "Content-Length": "999999" } }
          : undefined,
      );
    });
    await expect(
      new GPTReviewer(gptConfig, fetcher).evaluate(command),
    ).rejects.toBeDefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("never accepts a custom endpoint or invalid limits", () => {
    expect(() =>
      checkedOpenAIConfig({
        ...gptConfig,
        endpoint: "https://untrusted.test/v1/",
      }),
    ).toThrow();
    expect(() =>
      checkedOpenAIConfig({ ...gptConfig, timeoutMs: 100000 }),
    ).toThrow();
  });
});
