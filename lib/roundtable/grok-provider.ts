import { AppError } from "../ideas/errors";
import { redact } from "../imports/staging";
import { boundedJSON } from "../intelligence/responses";
import { checkedGrokConfig, type GrokConfig } from "./grok-config";
import { assessmentSchema, type RoundtableRequest } from "./model";
import { assessmentPayload, instructions, reportJSONSchema } from "./provider";

export const grokInstructions = instructions.replace(
  "You are GPT",
  "You are Grok",
);
export class GrokReviewer {
  private config: GrokConfig;
  constructor(
    config: GrokConfig,
    private fetcher: typeof fetch = fetch,
    private secrets: string[] = [],
  ) {
    this.config = checkedGrokConfig(config);
  }
  async evaluate(command: RoundtableRequest, signal?: AbortSignal) {
    const c = this.config,
      controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), c.timeoutMs);
    try {
      const response = await this.fetcher(c.endpoint + "chat/completions", {
        method: "POST",
        redirect: "manual",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + c.key,
        },
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        body: JSON.stringify({
          model: c.deployment,
          max_tokens: c.maxOutputTokens,
          stream: false,
          n: 1,
          messages: [
            { role: "system", content: grokInstructions },
            {
              role: "user",
              content: JSON.stringify(assessmentPayload(command)),
            },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "idea_lab_roundtable_independent",
              strict: true,
              schema: reportJSONSchema,
            },
          },
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new AppError(
          response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
          "xAI did not confirm a structured assessment. No automatic retry was made.",
          response.status === 429 ? 429 : 502,
        );
      }
      const raw = await boundedJSON(response),
        choice = raw.choices?.[0];
      if (
        raw.object !== "chat.completion" ||
        !Array.isArray(raw.choices) ||
        raw.choices.length !== 1 ||
        choice.finish_reason !== "stop" ||
        choice.message?.role !== "assistant" ||
        typeof choice.message.content !== "string" ||
        choice.message.refusal ||
        (choice.message.tool_calls?.length ?? 0) > 0 ||
        choice.message.function_call ||
        typeof raw.model !== "string" ||
        !raw.model.trim() ||
        raw.model.length > 200 ||
        typeof raw.id !== "string" ||
        !raw.id.trim() ||
        raw.id.length > 200
      )
        throw new AppError(
          "GROK_REPORT_INVALID",
          "Grok did not complete a usable assessment. No score was applied.",
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
        sanitize(JSON.parse(choice.message.content)),
      );
      if (!value.success)
        throw new AppError(
          "GROK_REPORT_INVALID",
          "Grok returned an invalid assessment. No score was applied.",
          502,
        );
      return {
        value: value.data,
        resolvedModel: clean(raw.model),
        responseId: clean(raw.id),
        usage:
          Number.isSafeInteger(raw.usage?.prompt_tokens) &&
          raw.usage.prompt_tokens >= 0 &&
          Number.isSafeInteger(raw.usage?.completion_tokens) &&
          raw.usage.completion_tokens >= 0
            ? {
                inputTokens: raw.usage.prompt_tokens,
                outputTokens: raw.usage.completion_tokens,
              }
            : null,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "AI_REQUEST_UNCONFIRMED",
        "No Grok result was confirmed. xAI may have processed the request. No retry was made.",
        503,
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }
}
