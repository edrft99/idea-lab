import { AppError } from "../ideas/errors";
import { redact } from "../imports/staging";
import { checkedAIConfig, type AIConfig } from "./config";
export async function boundedJSON(response: Response, maximum = 262144) {
  if (Number(response.headers.get("content-length") ?? 0) > maximum)
    throw new AppError(
      "AI_OUTPUT_TOO_LARGE",
      "The AI response exceeded the assessment limit.",
      502,
    );
  if (
    !response.headers
      .get("content-type")
      ?.toLowerCase()
      .includes("application/json") ||
    !response.body
  )
    throw new AppError(
      "AI_RESPONSE_INVALID",
      "The provider did not return an assessment response.",
      502,
    );
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maximum)
        throw new AppError(
          "AI_OUTPUT_TOO_LARGE",
          "The AI response exceeded the assessment limit.",
          502,
        );
      chunks.push(part.value);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {}
  }
  const data = new Uint8Array(total);
  let offset = 0;
  for (const part of chunks) {
    data.set(part, offset);
    offset += part.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    throw new AppError(
      "AI_RESPONSE_INVALID",
      "The provider returned invalid JSON.",
      502,
    );
  }
}

export class AzureStructuredResponses {
  private config: AIConfig;
  constructor(
    config: AIConfig,
    private fetcher: typeof fetch = fetch,
    private extraSecrets: string[] = [],
  ) {
    this.config = checkedAIConfig(config);
  }
  async generate<T>(
    request: {
      payload: unknown;
      instructions: string;
      schema: unknown;
      name: string;
      parse: (value: unknown) => T;
    },
    signal?: AbortSignal,
  ) {
    const c = this.config,
      controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), c.timeoutMs);
    try {
      const response = await this.fetcher(c.endpoint + "responses", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", "api-key": c.key },
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        body: JSON.stringify({
          model: c.deployment,
          store: false,
          stream: false,
          background: false,
          tools: [],
          tool_choice: "none",
          max_output_tokens: c.maxOutputTokens,
          instructions: request.instructions,
          input: [{ role: "user", content: JSON.stringify(request.payload) }],
          text: {
            format: {
              type: "json_schema",
              name: request.name,
              strict: true,
              schema: request.schema,
            },
          },
        }),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        throw new AppError(
          response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
          response.status === 429
            ? "The configured provider rate-limited this request. No automatic retry was made."
            : "The configured provider did not confirm a structured result. No automatic retry was made.",
          response.status === 429 ? 429 : 502,
        );
      }
      const raw = await boundedJSON(response);
      if (
        raw.object !== "response" ||
        raw.status !== "completed" ||
        raw.error ||
        raw.incomplete_details ||
        !Array.isArray(raw.output) ||
        raw.output.length > 10
      )
        throw new AppError(
          "AI_RESPONSE_INCOMPLETE",
          "The provider did not complete a usable result.",
          502,
        );
      if (
        raw.output.some(
          (item: any) => !["reasoning", "message"].includes(item.type),
        )
      )
        throw new AppError(
          "AI_RESPONSE_INVALID",
          "Tool output is not accepted as a result.",
          502,
        );
      const messages = raw.output.filter(
        (item: any) => item.type === "message",
      );
      if (
        messages.length !== 1 ||
        messages[0].role !== "assistant" ||
        messages[0].status !== "completed" ||
        !Array.isArray(messages[0].content) ||
        messages[0].content.length !== 1 ||
        messages[0].content[0].type !== "output_text" ||
        typeof messages[0].content[0].text !== "string"
      )
        throw new AppError(
          "AI_REFUSED_OR_INVALID",
          "The model refused or did not return the requested result.",
          502,
        );
      let output;
      try {
        output = JSON.parse(messages[0].content[0].text);
      } catch {
        throw new AppError(
          "AI_RESPONSE_INVALID",
          "The model result was not valid JSON.",
          502,
        );
      }
      if (
        typeof raw.model !== "string" ||
        !raw.model.trim() ||
        raw.model.length > 200 ||
        typeof raw.id !== "string" ||
        !raw.id.trim() ||
        raw.id.length > 200
      )
        throw new AppError(
          "AI_RESPONSE_INVALID",
          "The model result lacks valid provenance.",
          502,
        );
      const sanitize = (v: unknown): unknown =>
        typeof v === "string"
          ? redact(v, [c.key, ...this.extraSecrets])
          : Array.isArray(v)
            ? v.map(sanitize)
            : v && typeof v === "object"
              ? Object.fromEntries(
                  Object.entries(v).map(([k, value]) => [k, sanitize(value)]),
                )
              : v;
      const value = request.parse(sanitize(output));
      const usage =
        raw.usage &&
        Number.isSafeInteger(raw.usage.input_tokens) &&
        raw.usage.input_tokens >= 0 &&
        Number.isSafeInteger(raw.usage.output_tokens) &&
        raw.usage.output_tokens >= 0
          ? {
              inputTokens: raw.usage.input_tokens,
              outputTokens: raw.usage.output_tokens,
            }
          : null;
      return {
        value,
        resolvedModel: redact(raw.model, [c.key, ...this.extraSecrets]),
        responseId: redact(raw.id, [c.key, ...this.extraSecrets]),
        usage,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "AI_REQUEST_UNCONFIRMED",
        "No AI result was confirmed. The provider may have processed the request. No retry was made; review a new request explicitly if needed.",
        503,
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }
}
