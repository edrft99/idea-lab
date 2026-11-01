import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AzureResponsesExtraction,
  type ExtractionProvider,
} from "../lib/intelligence/extraction-provider";
import {
  AIExtractionService,
  verifyAIExtraction,
} from "../lib/intelligence/extraction-service";
import { AIAssessmentService } from "../lib/intelligence/service";
import {
  aiExtractionRequestSchema,
  modelExtractionSchema,
  aiExtractionResultSchema,
} from "../lib/intelligence/extraction-model";
import { Operations } from "../lib/ideas/operations";
import { NotionRepository } from "../lib/ideas/notion";
import { ProposalRepository } from "../lib/proposals/repository";
import { ProposalService } from "../lib/proposals/service";
import { storeProposalSchema } from "../lib/proposals/model";
import { downloadCheckpoint, readCheckpoint } from "../lib/imports/model";
import * as collector from "../lib/imports/notion-collector";
import { AppError } from "../lib/ideas/errors";
import { memoryDB, ids, input, config, idea } from "./fixtures";
import { setup as notionProvider, source, text } from "./proposal-fixtures";
import { aiConfig, command as assessmentCommand } from "./ai-fixtures";
import { draft } from "./assessment-fixtures";
const request = aiExtractionRequestSchema.parse({ source });
const generated: Awaited<ReturnType<ExtractionProvider["extract"]>> = {
  classification: "Idea",
  rationale: "The selected excerpt describes a reusable demonstration.",
  confidence: 0.8,
  data: input,
  resolvedModel: "resolved-extractor",
  responseId: "resp_extraction",
  usage: { inputTokens: 100, outputTokens: 200 },
};
const candidate = (({ status, effort, readiness, projectUrl, ...rest }) =>
  rest)(input);
const rawOutput = () => ({
  classification: "Idea",
  rationale: generated.rationale,
  confidence: 0.8,
  data: { ...candidate },
});
const response = (value: unknown = rawOutput()) => ({
  object: "response",
  id: "resp_extraction",
  model: "resolved-extractor",
  status: "completed",
  error: null,
  incomplete_details: null,
  output: [
    {
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: JSON.stringify(value) }],
    },
  ],
});
function setup(c = aiConfig) {
  const m = memoryDB(),
    ops = new Operations(m.db),
    provider = { extract: vi.fn().mockResolvedValue(generated) },
    repository = vi.fn(() => {
      throw new Error("Notion is not configured for file extraction.");
    });
  return {
    m,
    ops,
    provider,
    repository,
    service: new AIExtractionService(c, ops, provider, repository, [
      "synthetic-notion-secret",
    ]),
  };
}
afterEach(() => vi.restoreAllMocks());
describe("structured selected-excerpt extraction", () => {
  it.each(["Idea", "Routine", "Uncertain"] as const)(
    "accepts %s without granting model ownership of provenance or lifecycle",
    async (classification) => {
      const value = {
          ...rawOutput(),
          classification,
          data: classification === "Idea" ? candidate : null,
        },
        fetcher = vi.fn().mockResolvedValue(Response.json(response(value))),
        provider = new AzureResponsesExtraction(aiConfig, fetcher);
      const result = await provider.extract(request);
      expect(result.classification).toBe(classification);
      if (result.data)
        expect(result.data).toMatchObject({
          status: "Inbox",
          effort: "Unknown",
          readiness: "Discovery",
          projectUrl: "",
        });
      const body = JSON.parse(fetcher.mock.calls[0][1].body);
      expect(JSON.parse(body.input[0].content)).toEqual({
        role: source.role,
        selectedEvidence: source.evidence,
      });
      for (const absent of [
        source.conversationId,
        source.messageId,
        source.locator,
      ])
        expect(JSON.stringify(body)).not.toContain(absent);
      expect(body).toMatchObject({
        tools: [],
        tool_choice: "none",
        store: false,
        text: { format: { strict: true, name: "idea_lab_extraction" } },
      });
    },
  );
  it.each([
    "source-injection",
    "lifecycle-injection",
    "routine-candidate",
    "missing-idea",
    "bad-confidence",
    "category",
  ])("rejects invalid or unauthorized output: %s", async (kind) => {
    const value: any = rawOutput();
    if (kind === "source-injection")
      value.source = { conversationId: "forged" };
    if (kind === "lifecycle-injection") value.data.status = "Active";
    if (kind === "routine-candidate") value.classification = "Routine";
    if (kind === "missing-idea") value.data = null;
    if (kind === "bad-confidence") value.confidence = 2;
    if (kind === "category")
      value.data = { ...candidate, category: "Invented category" };
    const fetcher = vi.fn().mockResolvedValue(Response.json(response(value)));
    await expect(
      new AzureResponsesExtraction(aiConfig, fetcher).extract(request),
    ).rejects.toMatchObject({ code: "AI_EXTRACTION_INVALID" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([302, 429, 500])(
    "does not follow or retry provider HTTP %s",
    async (status) => {
      const fetcher = vi.fn().mockResolvedValue(
        new Response("private provider diagnostic", {
          status,
          headers: { Location: "https://attacker.test" },
        }),
      );
      await expect(
        new AzureResponsesExtraction(aiConfig, fetcher).extract(request),
      ).rejects.toMatchObject({ status: status === 429 ? 429 : 502 });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("treats refusal/tool output as failure and redacts credentials from valid text", async () => {
    const raw = response();
    (raw.output[0] as any) = {
      type: "function_call",
      name: "save_idea",
      arguments: "{}",
    };
    await expect(
      new AzureResponsesExtraction(
        aiConfig,
        vi.fn().mockResolvedValue(Response.json(raw)),
      ).extract(request),
    ).rejects.toMatchObject({ code: "AI_RESPONSE_INVALID" });
    const value = {
      ...rawOutput(),
      rationale: "Evidence " + aiConfig.key + " alice@example.test",
    };
    const result = await new AzureResponsesExtraction(
      aiConfig,
      vi.fn().mockResolvedValue(Response.json(response(value))),
    ).extract(request);
    expect(result.rationale).not.toContain(aiConfig.key);
    expect(result.rationale).toContain("REDACTED");
  });
});
describe("selected extraction consent and source attestation", () => {
  it("works for file excerpts without a Notion token, dispatches only after consent and never replays", async () => {
    const s = setup();
    try {
      const receipt = await s.service.prepare(request, "owner");
      expect(s.provider.extract).not.toHaveBeenCalled();
      expect(s.repository).not.toHaveBeenCalled();
      const { result } = await s.service.execute(
        receipt.command,
        receipt.approvalToken,
        "owner",
      );
      expect(await verifyAIExtraction(result, s.ops, "owner")).toEqual(result);
      expect(s.provider.extract).toHaveBeenCalledTimes(1);
      expect(s.repository).not.toHaveBeenCalled();
      await expect(
        s.service.execute(receipt.command, receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "AI_RESULT_NOT_RETAINED" });
      expect(
        JSON.stringify(await s.ops.read(receipt.approvalToken, "owner")),
      ).not.toContain(source.evidence);
    } finally {
      s.m.close();
    }
  });
  it("redacts selected evidence and withholds credential-bearing provenance URLs before review", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(
        {
          source: {
            ...source,
            evidence:
              source.evidence +
              " " +
              aiConfig.key +
              " synthetic-notion-secret alice@example.test",
            originalUrl: "https://example.test/?token=" + aiConfig.key,
          },
        },
        "owner",
      );
      expect(JSON.stringify(r)).not.toContain(aiConfig.key);
      expect(JSON.stringify(r)).not.toContain("synthetic-notion-secret");
      expect(r.command.source.originalUrl).toBeNull();
      expect(s.provider.extract).not.toHaveBeenCalled();
    } finally {
      s.m.close();
    }
  });
  it("binds actor, selected evidence, source identity, expiry and provider policy", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(request, "owner");
      await expect(
        s.service.execute(request, r.approvalToken, "other"),
      ).rejects.toMatchObject({ status: 403 });
      for (const changed of [
        { ...source, evidence: "Different selection" },
        { ...source, messageId: "different-message" },
      ]) {
        await expect(
          s.service.execute({ source: changed }, r.approvalToken, "owner"),
        ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      }
      const other = new AIExtractionService(
        { ...aiConfig, retentionNotice: "Changed policy" },
        s.ops,
        s.provider,
        s.repository,
      );
      await expect(
        other.execute(request, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
      await expect(
        s.service.execute(request, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(s.provider.extract).not.toHaveBeenCalled();
    } finally {
      s.m.close();
    }
  });
  it("rechecks selected Notion content at preview and under the source lock", async () => {
    const s = setup();
    try {
      const notion = aiExtractionRequestSchema.parse({
        source: {
          ...source,
          system: "Notion",
          role: "document",
          adapterVersion: "notion-selected-v1",
          conversationId: ids.idea,
          messageId: ids.source,
          originRevision: "2026-10-31T10:00:00Z",
          originalUrl: "https://www.notion.so/" + ids.idea.replaceAll("-", ""),
        },
      });
      s.repository.mockReturnValue({} as never);
      let changed = false;
      const verify = vi
        .spyOn(collector, "verifySelectedNotionSource")
        .mockImplementation(async () => {
          if (changed)
            throw new AppError("NOTION_SOURCE_CHANGED", "Source changed", 409);
        });
      const r = await s.service.prepare(notion, "owner");
      changed = true;
      await expect(
        s.service.execute(notion, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "NOTION_SOURCE_CHANGED" });
      expect(verify).toHaveBeenCalledTimes(2);
      expect(s.provider.extract).not.toHaveBeenCalled();
    } finally {
      s.m.close();
    }
  });
  it("shares hourly attempt limits with AI assessment and serializes concurrent extraction", async () => {
    const s = setup({ ...aiConfig, requestsPerHour: 1 });
    try {
      const evaluator = {
          evaluate: vi.fn().mockResolvedValue({
            draft,
            resolvedModel: "resolved-model",
            responseId: "resp_assessment",
            usage: null,
          }),
        },
        repo = { get: vi.fn().mockResolvedValue(idea) };
      const assessments = new AIAssessmentService(
        { ...aiConfig, requestsPerHour: 1 },
        repo as unknown as NotionRepository,
        s.ops,
        evaluator,
      );
      const a = await assessments.prepare(assessmentCommand, "owner");
      await assessments.execute(a.command, a.approvalToken, "owner");
      const r = await s.service.prepare(request, "owner");
      await expect(
        s.service.execute(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "AI_BUDGET_EXHAUSTED" });
      expect(s.provider.extract).not.toHaveBeenCalled();
    } finally {
      s.m.close();
    }
  });
  it("holds the source and owner budget locks during dispatch", async () => {
    const s = setup();
    try {
      const a = await s.service.prepare(request, "owner"),
        b = await s.service.prepare(request, "owner");
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      s.provider.extract.mockImplementation(async () => {
        await gate;
        return generated;
      });
      const first = s.service.execute(a.command, a.approvalToken, "owner");
      await vi.waitFor(() =>
        expect(s.provider.extract).toHaveBeenCalledTimes(1),
      );
      await expect(
        s.service.execute(b.command, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      release();
      await first;
    } finally {
      s.m.close();
    }
  });
  it("rejects forged extraction output or cross-owner proof", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(request, "owner"),
        { result } = await s.service.execute(
          r.command,
          r.approvalToken,
          "owner",
        );
      await expect(
        verifyAIExtraction({ ...result, rationale: "Forged" }, s.ops, "owner"),
      ).rejects.toMatchObject({ code: "AI_PROVENANCE_INVALID" });
      await expect(
        verifyAIExtraction(result, s.ops, "other"),
      ).rejects.toMatchObject({ status: 403 });
    } finally {
      s.m.close();
    }
  });
});
describe("editable extraction drafts, queue authority and canonical provenance", () => {
  it.each(["Idea", "Routine"] as const)(
    "preserves %s output and human edits across private progress, storage and acceptance",
    async (classification) => {
      const s = notionProvider(),
        repo = new ProposalRepository(config, s.fetcher),
        reviews = new ProposalService(repo, s.ops),
        provider = {
          extract: vi.fn().mockResolvedValue({
            ...generated,
            classification,
            data: classification === "Idea" ? input : null,
          }),
        },
        ai = new AIExtractionService(aiConfig, s.ops, provider, () => repo);
      try {
        const consent = await ai.prepare(request, "owner"),
          { result } = await ai.execute(
            consent.command,
            consent.approvalToken,
            "owner",
          );
        expect(s.writes()).toHaveLength(0);
        const edited = {
            ...input,
            title: "Human reviewed demonstration",
            summary: "Human corrected expected outcome.",
          },
          p = {
            id: crypto.randomUUID(),
            data: edited,
            source: result.input.source,
            ai: result,
            decision: "draft" as const,
            canonicalId: null,
          };
        const raw = downloadCheckpoint([p]);
        expect(JSON.parse(raw).version).toBe(2);
        const restored = readCheckpoint(raw).proposals[0];
        expect(restored.ai).toEqual(result);
        expect(restored.data).toEqual(edited);
        expect(raw).not.toContain(consent.approvalToken);
        const command = {
          data: edited,
          source: restored.source,
          ai: restored.ai,
          note: "Preserve selected AI origin.",
          reconsider: false,
          reconsiderReason: "",
          ...(classification === "Routine"
            ? {
                aiOverrideReason:
                  "The routine question contains a reusable demonstration concept.",
              }
            : {}),
        };
        if (classification === "Routine")
          expect(
            storeProposalSchema.safeParse({ ...command, aiOverrideReason: "" })
              .success,
          ).toBe(false);
        await expect(
          reviews.prepareStore(
            { ...command, source: { ...source, evidence: "Substituted" } },
            "owner",
          ),
        ).rejects.toMatchObject({ code: "AI_PROVENANCE_INVALID" });
        const receipt = await reviews.prepareStore(command, "owner");
        expect(
          receipt.changes.some(
            (c) => c.field === "AI origin and original result",
          ),
        ).toBe(true);
        const saved = await reviews.store(
            command,
            receipt.approvalToken,
            "owner",
          ),
          row = await repo.proposal(saved.reviewId!);
        expect(s.writes(ids.ideas)).toHaveLength(0);
        const decision = {
            decision: "Approve" as const,
            proposalId: row.id,
            proposalRevision: row.revision,
            data: edited,
            reason: "This reviewed outcome is useful.",
          },
          approval = await reviews.prepareDecision(decision, "owner");
        expect(
          approval.changes.some(
            (c) => c.field === "Preserved AI classification and human override",
          ),
        ).toBe(true);
        const accepted = await reviews.decide(
          decision,
          approval.approvalToken,
          "owner",
        );
        expect(accepted.idea?.title).toBe(edited.title);
        expect(accepted.idea?.priorityScore).toBeNull();
        const canonicalSource = s.rows.get(ids.source),
          snapshot = JSON.parse(
            canonicalSource.children[0].code.rich_text
              .map((t: any) => t.text.content)
              .join(""),
          );
        expect(snapshot.version).toBe(2);
        expect(snapshot.aiExtraction.classification).toBe(classification);
        expect(snapshot.aiExtraction.promptVersion).toBe("extraction-v1");
        expect(snapshot.source.evidence).toBe(source.evidence);
        expect(snapshot.aiReview.proposalId).toBe(row.id);
        expect(snapshot.aiReview.overrideReason).toBe(
          classification === "Routine" ? command.aiOverrideReason : null,
        );
        expect((await repo.proposal(row.id)).snapshot.command.ai).toEqual(
          result,
        );
      } finally {
        s.memory.close();
      }
    },
  );
  it("still reads legacy manual progress files and rejects unknown versions or source-swapped AI progress", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(request, "owner"),
        { result } = await s.service.execute(
          r.command,
          r.approvalToken,
          "owner",
        ),
        p = {
          id: crypto.randomUUID(),
          data: input,
          source,
          decision: "draft" as const,
          canonicalId: null,
        };
      const current = downloadCheckpoint([p]);
      expect(
        readCheckpoint(current.replace('"version": 2', '"version": 1'))
          .proposals[0].data,
      ).toEqual(input);
      expect(() =>
        readCheckpoint(current.replace('"version": 2', '"version": 3')),
      ).toThrow();
      expect(() =>
        downloadCheckpoint([
          { ...p, source: { ...source, evidence: "Changed" }, ai: result },
        ]),
      ).toThrow();
    } finally {
      s.m.close();
    }
  });
});

it("refuses a progress download that would exceed the matching restore limit", async () => {
  const s = setup();
  try {
    const r = await s.service.prepare(request, "owner"),
      { result } = await s.service.execute(r.command, r.approvalToken, "owner");
    const long = "界".repeat(2000),
      data = {
        ...input,
        title: "界".repeat(200),
        summary: long,
        problem: long,
        solution: long,
        audience: long,
        expectedValue: long,
        context: long,
        nextAction: long,
      };
    const proposals = Array.from({ length: 100 }, (_, n) => {
      const selected = {
        ...source,
        messageId: "large-" + n,
        evidence: "界".repeat(6000),
      };
      return {
        id: crypto.randomUUID(),
        data,
        source: selected,
        ai: { ...result, data, input: { source: selected } },
        decision: "draft" as const,
        canonicalId: null,
      };
    });
    expect(() => downloadCheckpoint(proposals)).toThrow(/exceed 10 MB/);
  } finally {
    s.m.close();
  }
});

it("keeps initial lifecycle server-owned even when a replacement adapter supplies different values", async () => {
  const s = setup();
  try {
    s.provider.extract.mockResolvedValue({
      ...generated,
      data: {
        ...input,
        status: "Active",
        effort: "Weekend",
        readiness: "Ready to build",
        projectUrl: "https://example.test/untrusted",
      },
    });
    const r = await s.service.prepare(request, "owner"),
      { result } = await s.service.execute(r.command, r.approvalToken, "owner");
    expect(result.data).toMatchObject({
      status: "Inbox",
      effort: "Unknown",
      readiness: "Discovery",
      projectUrl: "",
    });
  } finally {
    s.m.close();
  }
});
