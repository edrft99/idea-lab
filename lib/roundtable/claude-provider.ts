import { AppError } from "../ideas/errors";
import { redact } from "../imports/staging";
import { boundedJSON } from "../intelligence/responses";
import { checkedClaudeConfig, type ClaudeConfig } from "./claude-config";
import { assessmentSchema, type RoundtableRequest } from "./model";
import { assessmentPayload, instructions, reportJSONSchema } from "./provider";

// Only the speaker changes; the rubric and evidence payload are shared with GPT.
export const claudeInstructions = instructions.replace(
  "You are GPT",
  "You are Claude",
);
export class ClaudeReviewer {
  private config: ClaudeConfig;
  constructor(
    config: ClaudeConfig,
    private fetcher: typeof fetch = fetch,
    private secrets: string[] = [],
  ) {
    this.config = checkedClaudeConfig(config);
  }
  async evaluate(command: RoundtableRequest, signal?: AbortSignal) {
    const c = this.config,
      controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs);
    try {
      const response = await this.fetcher(c.endpoint + "messages", {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": c.key,
          "anthropic-version": "2023-06-01",
        },
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        body: JSON.stringify({
          model: c.deployment,
          max_tokens: c.maxOutputTokens,
          stream: false,
          system: claudeInstructions,
          messages: [
            {
              role: "user",
              content: JSON.stringify(assessmentPayload(command)),
            },
          ],
          output_config: {
            format: { type: "json_schema", schema: reportJSONSchema },
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
          "Anthropic did not confirm a structured assessment. No automatic retry was made.",
          response.status === 429 ? 429 : 502,
        );
      }
      const raw = await boundedJSON(response);
      if (
        raw.type !== "message" ||
        raw.role !== "assistant" ||
        raw.stop_reason !== "end_turn" ||
        !Array.isArray(raw.content) ||
        raw.content.length !== 1 ||
        raw.content[0].type !== "text" ||
        typeof raw.content[0].text !== "string" ||
        typeof raw.model !== "string" ||
        !raw.model.trim() ||
        raw.model.length > 200 ||
        typeof raw.id !== "string" ||
        !raw.id.trim() ||
        raw.id.length > 200
      )
        throw new AppError(
          "CLAUDE_REPORT_INVALID",
          "Claude did not complete a usable assessment. No score was applied.",
          502,
        );
      const clean = (text: string) => redact(text, [c.key, ...this.secrets]);
      const sanitize = (value: unknown): unknown =>
        typeof value === "string"
          ? clean(value)
          : Array.isArray(value)
            ? value.map(sanitize)
            : value && typeof value === "object"
              ? Object.fromEntries(
                  Object.entries(value).map(([key, v]) => [key, sanitize(v)]),
                )
              : value;
      const value = assessmentSchema.safeParse(
        sanitize(JSON.parse(raw.content[0].text)),
      );
      if (!value.success)
        throw new AppError(
          "CLAUDE_REPORT_INVALID",
          "Claude returned an invalid assessment. No score was applied.",
          502,
        );
      return {
        value: value.data,
        resolvedModel: clean(raw.model),
        responseId: clean(raw.id),
        usage:
          Number.isSafeInteger(raw.usage?.input_tokens) &&
          raw.usage.input_tokens >= 0 &&
          Number.isSafeInteger(raw.usage?.output_tokens) &&
          raw.usage.output_tokens >= 0
            ? {
                inputTokens: raw.usage.input_tokens,
                outputTokens: raw.usage.output_tokens,
              }
            : null,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "AI_REQUEST_UNCONFIRMED",
        "No Claude result was confirmed. Anthropic may have processed the request. No retry was made.",
        503,
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }
}
