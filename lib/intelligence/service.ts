import { AppError } from "../ideas/errors";
import { Operations, digest, type Operation } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { redact } from "../imports/staging";
import {
  aiEvaluationRequestSchema,
  aiResultSchema,
  type AIEvaluationRequest,
  type AIResult,
} from "./model";
import {
  checkedAIConfig,
  aiProfile,
  promptVersion,
  type AIConfig,
} from "./config";
import type { AssessmentProvider } from "./provider";
export function aiRequestStatus(op: Operation) {
  if (
    ![
      "ai-evaluate",
      "ai-extract",
      "roundtable-gpt",
      "roundtable-claude",
    ].includes(op.action)
  )
    throw new AppError("INVALID_OPERATION", "This is not an AI request.", 400);
  return {
    status: op.status,
    resultRetained: false,
    message:
      op.status === "done"
        ? "The request completed. Its result is retained only in the requesting browser or an explicitly downloaded/saved proposal."
        : ["running", "uncertain"].includes(op.status)
          ? "This request is still unconfirmed. It will not be replayed."
          : "No retained AI result is available from this request. A new request requires a new transmission review.",
  };
}
export async function verifyAIResult(
  value: AIResult,
  operations: Operations,
  actor: string,
) {
  const result = aiResultSchema.parse(value),
    op = await operations.readById(result.runId, actor);
  if (
    op.action !== "ai-evaluate" ||
    op.status !== "done" ||
    op.target !== result.ideaId ||
    op.result_id !== (await digest(JSON.stringify(result))) ||
    result.input.ideaId !== result.ideaId ||
    result.input.inputRevision !== result.inputRevision ||
    result.inputHash !== (await digest(JSON.stringify(result.input))) ||
    result.draft.rubricVersion !== result.input.rubricVersion ||
    JSON.stringify(result.draft.weights) !==
      JSON.stringify(result.input.weights)
  )
    throw new AppError(
      "AI_PROVENANCE_INVALID",
      "This assessment does not match a confirmed AI result for the current owner.",
      409,
    );
  return result;
}
export class AIAssessmentService {
  private config: AIConfig;
  constructor(
    config: AIConfig,
    private repository: NotionRepository,
    private operations: Operations,
    private provider: AssessmentProvider,
    private secrets: string[] = [],
  ) {
    this.config = checkedAIConfig(config);
  }
  private normalized(input: AIEvaluationRequest) {
    const c = aiEvaluationRequestSchema.parse(input),
      selection = Object.fromEntries(
        Object.entries(c.selection).map(([key, value]) => [
          key,
          redact(value!, [this.config.key, ...this.secrets]),
        ]),
      );
    return aiEvaluationRequestSchema.parse({ ...c, selection });
  }
  private async context() {
    return digest(
      JSON.stringify([aiProfile(this.config), await digest(this.config.key)]),
    );
  }
  private async current(c: AIEvaluationRequest) {
    const idea = await this.repository.get(c.ideaId);
    if (idea.canonicalIdeaId)
      throw new AppError(
        "SUPERSEDED_IDEA",
        "Assess the surviving idea.",
        409,
        undefined,
        false,
        [idea.canonicalIdeaId],
      );
    if (idea.revision !== c.inputRevision)
      throw new AppError(
        "STALE_IDEA",
        "This idea changed. Reload it before requesting an AI assessment.",
        409,
      );
    return idea;
  }
  async prepare(input: AIEvaluationRequest, actor: string) {
    const c = this.normalized(input);
    await this.current(c);
    const profile = aiProfile(this.config),
      receipt = await this.operations.issue(
        actor,
        await digest(JSON.stringify(c)),
        "ai-evaluate",
        c.ideaId,
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
          field: "Exact selected excerpts",
          before: "",
          after: JSON.stringify(c.selection, null, 2),
        },
        {
          field: "Rubric and weights",
          before: "",
          after: c.rubricVersion + "\n" + JSON.stringify(c.weights),
        },
        {
          field: "Request limits",
          before: "",
          after:
            "One request; no automatic retry. Up to " +
            profile.maxOutputTokens +
            " output tokens; " +
            profile.requestsPerHour +
            " requests per owner per hour. Provider usage may incur charges.",
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
            "Send only the selected excerpts and rubric. Return an unapproved AI assessment to this browser. No Notion record, evaluation history or active score will be written.",
        },
      ],
    };
  }
  async execute(
    input: AIEvaluationRequest,
    token: string,
    actor: string,
    signal?: AbortSignal,
  ) {
    const c = this.normalized(input),
      hash = await digest(JSON.stringify(c)),
      op = await this.operations.read(token, actor);
    if (
      op.action !== "ai-evaluate" ||
      op.payload_hash !== hash ||
      op.target !== c.ideaId ||
      op.expected_revision !== (await this.context())
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The selected content, provider or policy changed. Review transmission again.",
        409,
      );
    if (op.status === "done")
      throw new AppError(
        "AI_RESULT_NOT_RETAINED",
        "This request already completed. Use the result in its original browser, private download or saved proposal. It will not be sent again.",
        409,
      );
    await this.operations.claim(op, hash, [
      "ai-budget:" + (await digest(actor)),
    ]);
    try {
      const count = await this.operations.countAIAttempts(
        actor,
        Date.now() - 3600000,
      );
      if (count > this.config.requestsPerHour)
        throw new AppError(
          "AI_BUDGET_EXHAUSTED",
          "The configured hourly request budget has been reached. No provider request was sent.",
          429,
        );
      await this.current(c);
      const requestedAt = new Date().toISOString(),
        generated = await this.provider.evaluate(c, signal);
      const result = aiResultSchema.parse({
        format: "idea-lab-ai-assessment",
        version: 1,
        runId: op.id,
        ideaId: c.ideaId,
        inputRevision: c.inputRevision,
        input: c,
        inputHash: hash,
        draft: generated.draft,
        provider: this.config.provider,
        endpoint: this.config.endpoint,
        deployment: this.config.deployment,
        resolvedModel: generated.resolvedModel,
        promptVersion,
        responseId: generated.responseId,
        retentionNotice: this.config.retentionNotice,
        maxOutputTokens: this.config.maxOutputTokens,
        requestedAt,
        completedAt: new Date().toISOString(),
        usage: generated.usage,
      });
      // Generated weights and rubric are fixed by the reviewed request, never by model output.
      if (
        result.draft.rubricVersion !== c.rubricVersion ||
        JSON.stringify(result.draft.weights) !== JSON.stringify(c.weights)
      )
        throw new AppError(
          "AI_ASSESSMENT_INVALID",
          "The model result differs from the approved rubric.",
          502,
        );
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
