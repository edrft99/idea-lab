import { editableIdeaSchema } from "../ideas/domain";
import { AppError } from "../ideas/errors";
import { Operations, digest } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { redact } from "../imports/staging";
import {
  importSourceSchema,
  sourceKey,
  sourceRevision,
} from "../imports/provenance";
import { verifySelectedNotionSource } from "../imports/notion-collector";
import { checkedAIConfig, aiProfile, type AIConfig } from "./config";
import {
  aiExtractionRequestSchema,
  aiExtractionResultSchema,
  extractionPromptVersion,
  type AIExtractionRequest,
  type AIExtractionResult,
} from "./extraction-model";
import type { ExtractionProvider } from "./extraction-provider";
export async function verifyAIExtraction(
  value: AIExtractionResult,
  operations: Operations,
  actor: string,
) {
  const result = aiExtractionResultSchema.parse(value),
    op = await operations.readById(result.runId, actor);
  if (
    op.action !== "ai-extract" ||
    op.status !== "done" ||
    op.target !== result.sourceKey ||
    op.result_id !== (await digest(JSON.stringify(result))) ||
    result.inputHash !== (await digest(JSON.stringify(result.input))) ||
    result.sourceKey !== (await sourceKey(result.input.source)) ||
    result.sourceRevision !== (await sourceRevision(result.input.source))
  )
    throw new AppError(
      "AI_PROVENANCE_INVALID",
      "This extraction does not match a confirmed AI result for the current owner.",
      409,
    );
  return result;
}
export class AIExtractionService {
  private config: AIConfig;
  constructor(
    config: AIConfig,
    private operations: Operations,
    private provider: ExtractionProvider,
    private repository: () => NotionRepository,
    private secrets: string[] = [],
  ) {
    this.config = checkedAIConfig(config);
  }
  private normalized(input: AIExtractionRequest) {
    const c = aiExtractionRequestSchema.parse(input),
      secret = [this.config.key, ...this.secrets],
      s = c.source,
      url = s.originalUrl;
    return aiExtractionRequestSchema.parse({
      source: importSourceSchema.parse({
        ...s,
        evidence: redact(s.evidence, secret),
        locator: redact(s.locator, secret),
        conversationId: redact(s.conversationId, secret),
        messageId: redact(s.messageId, secret),
        adapterVersion: redact(s.adapterVersion, secret),
        originalUrl: url && redact(url, secret) === url ? url : null,
      }),
    });
  }
  private async current(c: AIExtractionRequest) {
    if (c.source.system === "Notion")
      await verifySelectedNotionSource(this.repository(), c.source);
  }
  private context() {
    return digest(
      JSON.stringify([
        aiProfile(this.config, extractionPromptVersion),
        this.config.key,
      ]),
    );
  }
  async prepare(input: AIExtractionRequest, actor: string) {
    const c = this.normalized(input);
    await this.current(c);
    const key = await sourceKey(c.source),
      profile = aiProfile(this.config, extractionPromptVersion),
      receipt = await this.operations.issue(
        actor,
        await digest(JSON.stringify(c)),
        "ai-extract",
        key,
        await this.context(),
      );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      command: c,
      profile,
      changes: [
        {
          field: "Destination and deployment",
          before: "No transmission",
          after:
            profile.endpoint +
            "responses\nDeployment: " +
            profile.deployment +
            "\nPrompt: " +
            profile.promptVersion,
        },
        {
          field: "Exact model input",
          before: "",
          after: JSON.stringify(
            { role: c.source.role, selectedEvidence: c.source.evidence },
            null,
            2,
          ),
        },
        {
          field: "Preserved provenance (not sent to the model)",
          before: "",
          after:
            c.source.system +
            " · " +
            c.source.locator +
            "\nRevision: " +
            (await sourceRevision(c.source)),
        },
        {
          field: "Request limits",
          before: "",
          after:
            "One request; no automatic retries. Up to " +
            profile.maxOutputTokens +
            " output tokens; shared " +
            profile.requestsPerHour +
            " AI attempts per owner per hour. Provider usage may incur charges.",
        },
        {
          field: "Retention",
          before: "",
          after:
            profile.retentionNotice +
            "\n" +
            profile.requestStorage +
            "\n" +
            profile.localRetention,
        },
        {
          field: "Scope",
          before: "",
          after:
            "Classify this excerpt as Idea, Routine or Uncertain and return at most one candidate. No collection search, Notion record, merge, score or canonical idea is created. Source provenance and lifecycle remain server-owned.",
        },
      ],
    };
  }
  async execute(
    input: AIExtractionRequest,
    token: string,
    actor: string,
    signal?: AbortSignal,
  ) {
    const c = this.normalized(input),
      hash = await digest(JSON.stringify(c)),
      key = await sourceKey(c.source),
      op = await this.operations.read(token, actor);
    if (
      op.action !== "ai-extract" ||
      op.payload_hash !== hash ||
      op.target !== key ||
      op.expected_revision !== (await this.context())
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The excerpt, provenance, provider or policy changed. Review transmission again.",
        409,
      );
    if (op.status === "done")
      throw new AppError(
        "AI_RESULT_NOT_RETAINED",
        "This extraction completed. Use its browser result or private progress download; it will not be sent again.",
        409,
      );
    await this.operations.claim(op, hash, [
      "ai-budget:" + (await digest(actor)),
    ]);
    try {
      if (
        (await this.operations.countAIAttempts(actor, Date.now() - 3600000)) >
        this.config.requestsPerHour
      )
        throw new AppError(
          "AI_BUDGET_EXHAUSTED",
          "The shared hourly AI attempt budget was reached. No provider request was sent.",
          429,
        );
      await this.current(c);
      const requestedAt = new Date().toISOString(),
        generated = await this.provider.extract(c, signal);
      const result = aiExtractionResultSchema.parse({
        ...generated,
        data: generated.data
          ? editableIdeaSchema.parse({
              ...generated.data,
              status: "Inbox",
              effort: "Unknown",
              readiness: "Discovery",
              projectUrl: "",
            })
          : null,
        format: "idea-lab-ai-extraction",
        version: 1,
        runId: op.id,
        inputHash: hash,
        input: c,
        sourceKey: key,
        sourceRevision: await sourceRevision(c.source),
        provider: this.config.provider,
        endpoint: this.config.endpoint,
        deployment: this.config.deployment,
        retentionNotice: this.config.retentionNotice,
        maxOutputTokens: this.config.maxOutputTokens,
        promptVersion: extractionPromptVersion,
        requestedAt,
        completedAt: new Date().toISOString(),
      });
      await this.operations.finish(
        op.id,
        "done",
        await digest(JSON.stringify(result)),
      );
      return { result };
    } catch (error) {
      try {
        await this.operations.finish(op.id, "failed");
      } catch {}
      throw error;
    }
  }
}
