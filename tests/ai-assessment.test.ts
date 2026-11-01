import { describe, it, expect, vi } from "vitest";
import { AzureResponsesAssessment } from "../lib/intelligence/provider";
import { checkedAIConfig, type AIConfig } from "../lib/intelligence/config";
import {
  AIAssessmentService,
  verifyAIResult,
  aiRequestStatus,
} from "../lib/intelligence/service";
import {
  aiEvaluationRequestSchema,
  modelAssessmentSchema,
} from "../lib/intelligence/model";
import { Operations } from "../lib/ideas/operations";
import { NotionRepository } from "../lib/ideas/notion";
import { AssessmentRepository } from "../lib/evaluations/proposal-repository";
import { AssessmentService } from "../lib/evaluations/proposal-service";
import { draft } from "./assessment-fixtures";
import { memoryDB, idea, ids, config as notionConfig, page } from "./fixtures";
import { setup as notionProvider, text } from "./proposal-fixtures";
import { aiConfig, command } from "./ai-fixtures";
const output = () =>
  modelAssessmentSchema.parse(
    (({ rubricVersion, weights, ...rest }) => rest)(draft),
  );
function response(value: unknown = output()) {
  return {
    object: "response",
    id: "resp_synthetic",
    model: "resolved-model-version",
    status: "completed",
    error: null,
    incomplete_details: null,
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [
          { type: "output_text", text: JSON.stringify(value), annotations: [] },
        ],
      },
    ],
    usage: { input_tokens: 80, output_tokens: 300 },
  };
}
function setup(config = aiConfig) {
  const m = memoryDB(),
    ops = new Operations(m.db),
    repo = { get: vi.fn().mockResolvedValue(idea) },
    provider = {
      evaluate: vi.fn().mockResolvedValue({
        draft,
        resolvedModel: "resolved-model-version",
        responseId: "resp_synthetic",
        usage: { inputTokens: 80, outputTokens: 300 },
      }),
    };
  return {
    m,
    ops,
    repo,
    provider,
    service: new AIAssessmentService(
      config,
      repo as unknown as NotionRepository,
      ops,
      provider,
      ["synthetic-notion-secret"],
    ),
  };
}
describe("bounded Azure Responses assessment provider", () => {
  it("uses reviewed excerpts/rubric only, strict JSON, no tools/storage/streaming, one configured deployment", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(response())),
      p = new AzureResponsesAssessment(aiConfig, fetcher);
    expect((await p.evaluate(command)).draft).toEqual(draft);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, request] = fetcher.mock.calls[0],
      body = JSON.parse(request.body);
    expect(url).toBe(aiConfig.endpoint + "responses");
    expect(request.redirect).toBe("manual");
    expect(request.headers["api-key"]).toBe(aiConfig.key);
    expect(body).toMatchObject({
      model: aiConfig.deployment,
      store: false,
      stream: false,
      background: false,
      tools: [],
      tool_choice: "none",
      max_output_tokens: 4096,
      text: { format: { type: "json_schema", strict: true } },
    });
    const input = JSON.parse(body.input[0].content);
    expect(input).toEqual({
      rubricVersion: command.rubricVersion,
      weights: command.weights,
      selectedEvidence: command.selection,
    });
    expect(JSON.stringify(body)).not.toContain(ids.idea);
    expect(JSON.stringify(body)).not.toContain(command.inputRevision);
  });
  it.each([
    "http://synthetic-resource.openai.azure.com/openai/v1/",
    "https://localhost/openai/v1/",
    "https://synthetic-resource.openai.azure.com.attacker.test/openai/v1/",
    "https://synthetic-resource.openai.azure.com:4430/openai/v1/",
    "https://synthetic-resource.openai.azure.com/openai/v1/?secret=foo",
    "https://user:pass@synthetic-resource.openai.azure.com/openai/v1/",
    "https://synthetic-resource.openai.azure.com/openai/deployments/x/",
  ])("rejects unsafe configured destination %s", (endpoint) => {
    expect(() => checkedAIConfig({ ...aiConfig, endpoint })).toThrow();
    expect(() =>
      checkedAIConfig({ ...aiConfig, retentionNotice: "" }),
    ).toThrow();
  });
  it.each([302, 403, 429, 500])(
    "does not follow or retry HTTP %s",
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response("private provider diagnostic", {
          status,
          headers: { Location: "https://attacker.test" },
        }),
      );
      await expect(
        new AzureResponsesAssessment(aiConfig, fetcher).evaluate(command),
      ).rejects.toMatchObject({
        code: status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "invalid-rating",
    "approval-injection",
    "missing-evidence",
    "refusal",
    "incomplete",
    "tool",
    "multiple-messages",
  ])("rejects unusable or unauthorized model output: %s", async (kind) => {
    const raw = response();
    if (kind === "invalid-rating")
      raw.output[0].content[0].text = JSON.stringify({
        ...output(),
        ratings: { ...draft.ratings, impact: 6 },
      });
    if (kind === "approval-injection")
      raw.output[0].content[0].text = JSON.stringify({
        ...output(),
        applyToIdea: true,
      });
    if (kind === "missing-evidence")
      raw.output[0].content[0].text = JSON.stringify({
        ...output(),
        evidence: { impact: "Only one dimension" },
      });
    if (kind === "refusal")
      (raw.output[0].content[0] as any) = { type: "refusal", refusal: "No" };
    if (kind === "incomplete") raw.status = "incomplete";
    if (kind === "tool")
      (raw.output[0] as any) = {
        type: "function_call",
        name: "save_idea",
        arguments: "{}",
      };
    if (kind === "multiple-messages") raw.output.push(raw.output[0]);
    const fetcher = vi.fn().mockResolvedValue(Response.json(raw));
    await expect(
      new AzureResponsesAssessment(aiConfig, fetcher).evaluate(command),
    ).rejects.toMatchObject({ status: 502 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("bounds streamed response bytes and cancels oversized bodies", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(262145));
            c.close();
          },
        }),
        { headers: { "Content-Type": "application/json" } },
      ),
    );
    await expect(
      new AzureResponsesAssessment(aiConfig, fetcher).evaluate(command),
    ).rejects.toMatchObject({ code: "AI_OUTPUT_TOO_LARGE" });
  });
  it("redacts known credentials, emails and private paths in model text", async () => {
    const value = {
      ...output(),
      rationale:
        aiConfig.key + " alice@example.test C:\\Users\\Synthetic\\private.txt",
    };
    const p = new AzureResponsesAssessment(
      aiConfig,
      vi.fn().mockResolvedValue(Response.json(response(value))),
    );
    const saved = await p.evaluate(command);
    expect(saved.draft.rationale).not.toContain(aiConfig.key);
    expect(saved.draft.rationale).not.toContain("alice@example.test");
    expect(saved.draft.rationale).toContain("REDACTED");
  });
  it("aborts timed-out requests without a retry or private diagnostics", async () => {
    const fetcher = vi.fn(
      async (_url: any, init: any) =>
        new Promise((_resolve, reject) =>
          init.signal.addEventListener("abort", () =>
            reject(new Error("private key " + aiConfig.key)),
          ),
        ),
    );
    await expect(
      new AzureResponsesAssessment(aiConfig, fetcher as typeof fetch).evaluate(
        command,
      ),
    ).rejects.toMatchObject({ code: "AI_REQUEST_UNCONFIRMED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
describe("explicit AI transmission consent", () => {
  it("prepares without a model call, redacts selected content, binds output and stores hashes only", async () => {
    const s = setup();
    try {
      const input = {
        ...command,
        selection: {
          summary:
            "Selected evidence " +
            aiConfig.key +
            " alice@example.test synthetic-notion-secret",
        },
      };
      const receipt = await s.service.prepare(input, "owner");
      expect(s.provider.evaluate).not.toHaveBeenCalled();
      expect(JSON.stringify(receipt)).not.toContain(aiConfig.key);
      expect(JSON.stringify(receipt.command)).not.toContain(
        "alice@example.test",
      );
      const { result } = await s.service.execute(
        receipt.command,
        receipt.approvalToken,
        "owner",
      );
      expect(s.provider.evaluate.mock.calls[0][0]).toEqual(receipt.command);
      expect(await verifyAIResult(result, s.ops, "owner")).toEqual(result);
      const op = await s.ops.read(receipt.approvalToken, "owner");
      expect(op.status).toBe("done");
      expect(op.result_id).toMatch(/^[a-f0-9]{64}$/);
      expect(JSON.stringify(op)).not.toContain(result.draft.rationale);
      await expect(
        s.service.execute(receipt.command, receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "AI_RESULT_NOT_RETAINED" });
      expect(s.provider.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      s.m.close();
    }
  });
  it("rejects actor, payload and endpoint/policy/credential substitution before dispatch", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(command, "owner");
      await expect(
        s.service.execute(command, r.approvalToken, "other"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        s.service.execute(
          { ...command, selection: { summary: "Changed" } },
          r.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      for (const change of [
        { deployment: "other" },
        { retentionNotice: "Changed policy" },
        { key: "rotated-synthetic-key" },
      ]) {
        const other = new AIAssessmentService(
          { ...aiConfig, ...change },
          s.repo as unknown as NotionRepository,
          s.ops,
          s.provider,
        );
        await expect(
          other.execute(command, r.approvalToken, "owner"),
        ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      }
      expect(s.provider.evaluate).not.toHaveBeenCalled();
    } finally {
      s.m.close();
    }
  });
  it("rejects stale input and expiry, including edits after transmission review", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(command, "owner");
      s.repo.get.mockResolvedValue({ ...idea, revision: "changed" });
      await expect(
        s.service.execute(command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      expect(s.provider.evaluate).not.toHaveBeenCalled();
      s.repo.get.mockResolvedValue(idea);
      const r2 = await s.service.prepare(command, "owner");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
      await expect(
        s.service.execute(command, r2.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    } finally {
      vi.restoreAllMocks();
      s.m.close();
    }
  });
  it("enforces the hourly budget under a shared owner lock", async () => {
    const s = setup({ ...aiConfig, requestsPerHour: 1 });
    try {
      const first = await s.service.prepare(command, "owner");
      await s.service.execute(command, first.approvalToken, "owner");
      const next = await s.service.prepare(command, "owner");
      await expect(
        s.service.execute(command, next.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "AI_BUDGET_EXHAUSTED" });
      expect(s.provider.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      s.m.close();
    }
  });
  it("does not retry failed or interrupted dispatch and reports status without another provider call", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(command, "owner");
      s.provider.evaluate.mockRejectedValue(
        new Error("Synthetic failed dispatch"),
      );
      await expect(
        s.service.execute(command, r.approvalToken, "owner"),
      ).rejects.toThrow();
      expect(
        aiRequestStatus(await s.ops.read(r.approvalToken, "owner")),
      ).toMatchObject({ status: "failed", resultRetained: false });
      await expect(
        s.service.execute(command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(s.provider.evaluate).toHaveBeenCalledTimes(1);
    } finally {
      s.m.close();
    }
  });
  it("rejects changed or cross-owner AI result proof", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(command, "owner"),
        { result } = await s.service.execute(command, r.approvalToken, "owner");
      await expect(
        verifyAIResult({ ...result, resolvedModel: "forged" }, s.ops, "owner"),
      ).rejects.toMatchObject({ code: "AI_PROVENANCE_INVALID" });
      await expect(
        verifyAIResult(result, s.ops, "other"),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      s.m.close();
    }
  });
});
describe("AI result to authoritative assessment proposal", () => {
  it("requires separate storage/acceptance approvals and preserves AI provenance without changing a manual score", async () => {
    const s = notionProvider();
    s.rows.set(ids.idea, page());
    s.rows.get(ids.idea).properties["Score Authority"].select = {
      name: "manual-approved",
    };
    s.rows.get(ids.idea).properties["Priority Score"].number = 45;
    const repo = new AssessmentRepository(notionConfig, s.fetcher),
      provider = {
        evaluate: vi.fn().mockResolvedValue({
          draft,
          resolvedModel: "resolved-model-version",
          responseId: "resp_synthetic",
          usage: null,
        }),
      },
      ai = new AIAssessmentService(aiConfig, repo, s.ops, provider),
      reviews = new AssessmentService(repo, s.ops);
    try {
      const consent = await ai.prepare(command, "owner"),
        { result } = await ai.execute(command, consent.approvalToken, "owner");
      expect(s.writes()).toHaveLength(0);
      const store = {
        ideaId: ids.idea,
        inputRevision: idea.revision,
        draft,
        ai: result,
        note: "Review AI evidence.",
        reconsider: false,
        reconsiderReason: "",
      };
      await expect(
        reviews.prepareStore(
          { ...store, draft: { ...draft, rationale: "Substituted" } },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "AI_PROVENANCE_INVALID" });
      const receipt = await reviews.prepareStore(store, "owner");
      expect(
        receipt.changes.some((c) => c.field === "AI origin and selected input"),
      ).toBe(true);
      const saved = await reviews.store(store, receipt.approvalToken, "owner"),
        row = await repo.proposal(saved.reviewId!);
      expect(s.writes(ids.evaluations)).toHaveLength(0);
      const decision = {
          decision: "Approve" as const,
          proposalId: row.id,
          proposalRevision: row.revision,
          reason: "The AI evidence is inspectable.",
          applyToIdea: false,
          replaceManualScore: false,
          overrideReason: "",
        },
        approval = await reviews.prepareDecision(decision, "owner");
      await expect(
        reviews.prepareDecision({ ...decision, applyToIdea: true }, "owner"),
      ).rejects.toMatchObject({ code: "MANUAL_SCORE_PROTECTED" });
      await reviews.decide(decision, approval.approvalToken, "owner");
      expect((await repo.get(ids.idea)).priorityScore).toBe(45);
      const evaluation = [...s.rows.values()].find(
        (p) => p.parent.data_source_id === ids.evaluations,
      );
      expect(text(evaluation.properties["Model Identifier"])).toBe(
        "resolved-model-version",
      );
      const snapshot = JSON.parse(
        evaluation.children[1].code.rich_text
          .map((t: any) => t.text.content)
          .join(""),
      );
      expect(snapshot.origin).toBe("ai");
      expect(snapshot.promptVersion).toBe("assessment-v1");
      expect(snapshot.ai.input.selection).toEqual(command.selection);
      expect(s.writes(ids.evaluations)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
});

it("serializes dispatch across receipts using the owner request-budget lock", async () => {
  const s = setup();
  try {
    const a = await s.service.prepare(command, "owner"),
      b = await s.service.prepare(command, "owner");
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    s.provider.evaluate.mockImplementation(async () => {
      await gate;
      return {
        draft,
        resolvedModel: "resolved-model-version",
        responseId: "resp_synthetic",
        usage: { inputTokens: 80, outputTokens: 300 },
      };
    });
    const first = s.service.execute(command, a.approvalToken, "owner");
    await vi.waitFor(() =>
      expect(s.provider.evaluate).toHaveBeenCalledTimes(1),
    );
    await expect(
      s.service.execute(command, b.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    expect(s.provider.evaluate).toHaveBeenCalledTimes(1);
    release();
    await first;
  } finally {
    s.m.close();
  }
});
