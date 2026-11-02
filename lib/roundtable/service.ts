import { AppError } from "../ideas/errors";
import { digest, Operations } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { redact } from "../imports/staging";
import {
  aiProfile,
  checkedAIConfig,
  type AIConfig,
} from "../intelligence/config";
import {
  checkedOpenAIConfig,
  type OpenAIConfig,
} from "../intelligence/openai-config";
import type { GPTReviewer } from "./provider";
import {
  requestSchema,
  resultSchema,
  promptVersion,
  rubricVersion,
  type RoundtableRequest,
} from "./model";
export class RoundtableService {
  private config: AIConfig | OpenAIConfig;
  constructor(
    config: AIConfig | OpenAIConfig,
    private repository: NotionRepository,
    private operations: Operations,
    private provider: Pick<GPTReviewer, "evaluate">,
    private secrets: string[] = [],
  ) {
    this.config =
      config.provider === "openai-responses"
        ? checkedOpenAIConfig(config)
        : checkedAIConfig(config);
  }
  private normalized(input: RoundtableRequest) {
    const command = requestSchema.parse(input);
    const clean = (value: string) =>
      redact(value, [this.config.key, ...this.secrets]);
    return requestSchema.parse({
      ...command,
      selection: Object.fromEntries(
        Object.entries(command.selection).map(([key, value]) => [
          key,
          clean(value!),
        ]),
      ),
      successCriteria: clean(command.successCriteria),
      constraints: clean(command.constraints),
    });
  }
  private async context() {
    return digest(
      JSON.stringify([
        aiProfile(this.config, promptVersion),
        await digest(this.config.key),
      ]),
    );
  }
  private async current(command: RoundtableRequest) {
    const idea = await this.repository.get(command.ideaId);
    if (idea.canonicalIdeaId)
      throw new AppError(
        "SUPERSEDED_IDEA",
        "Evaluate the surviving idea after this merge.",
        409,
      );
    if (idea.revision !== command.inputRevision)
      throw new AppError(
        "STALE_IDEA",
        "This idea changed. Reload before requesting GPT’s assessment.",
        409,
      );
  }
  async prepare(input: RoundtableRequest, actor: string) {
    const command = this.normalized(input);
    await this.current(command);
    const receipt = await this.operations.issue(
      actor,
      await digest(JSON.stringify(command)),
      "roundtable-gpt",
      command.ideaId,
      await this.context(),
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      command,
      profile: aiProfile(this.config, promptVersion),
    };
  }
  async execute(
    input: RoundtableRequest,
    token: string,
    actor: string,
    signal?: AbortSignal,
  ) {
    const command = this.normalized(input),
      hash = await digest(JSON.stringify(command));
    const op = await this.operations.read(token, actor);
    if (
      op.action !== "roundtable-gpt" ||
      op.target !== command.ideaId ||
      op.payload_hash !== hash ||
      op.expected_revision !== (await this.context())
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The content or GPT connection changed. Review the request again.",
        409,
      );
    if (op.status === "done")
      throw new AppError(
        "AI_RESULT_NOT_RETAINED",
        "GPT already completed this request. Use the original result or its download. It will not be sent again.",
        409,
      );
    await this.operations.claim(op, hash, [
      "ai-budget:" + (await digest(actor)),
    ]);
    let dispatched = false;
    try {
      if (
        (await this.operations.countAIAttempts(actor, Date.now() - 3600000)) >
        this.config.requestsPerHour
      )
        throw new AppError(
          "AI_BUDGET_EXHAUSTED",
          "The hourly AI request budget has been reached. Nothing was sent to GPT.",
          429,
        );
      await this.current(command);
      const requestedAt = new Date().toISOString();
      dispatched = true;
      const generated = await this.provider.evaluate(command, signal);
      const result = resultSchema.parse({
        format: "idea-lab-roundtable",
        version: 1,
        runId: op.id,
        participant: "gpt",
        stage: "independent",
        input: command,
        inputHash: hash,
        assessment: generated.value,
        provider: this.config.provider,
        endpoint: this.config.endpoint,
        model: this.config.deployment,
        resolvedModel: generated.resolvedModel,
        responseId: generated.responseId,
        rubricVersion,
        promptVersion,
        requestedAt,
        completedAt: new Date().toISOString(),
        usage: generated.usage,
      });
      await this.operations.finishRoundtableRequest(
        op.id,
        "done",
        await digest(JSON.stringify(result)),
      );
      return { result };
    } catch (error) {
      try {
        await this.operations.finishRoundtableRequest(
          op.id,
          dispatched ? "uncertain" : "failed",
        );
      } catch {}
      if (dispatched)
        throw new AppError(
          "GPT_REQUEST_UNCONFIRMED",
          "No usable GPT result was retained. The request may have been processed or charged. It will not be replayed. Check request status before deciding whether to review a new request.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
}
export async function roundtableRequestStatus(
  operations: Operations,
  token: string,
  actor: string,
) {
  const op = await operations.read(token, actor);
  if (op.action !== "roundtable-gpt")
    throw new AppError(
      "INVALID_OPERATION",
      "This is not a GPT roundtable request.",
      400,
    );
  return {
    status: op.status,
    resultRetained: false,
    message:
      op.status === "done"
        ? "GPT completed this request. Its result is in the original browser or a private download; it cannot be fetched from the ledger."
        : op.status === "pending" || op.status === "failed"
          ? "No GPT dispatch was confirmed for this request."
          : "The request is unconfirmed and will not be replayed. Check the provider’s usage before authorising a replacement request.",
  };
}
