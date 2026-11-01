import { AppError } from "../ideas/errors";
import { redact } from "../imports/staging";
import { boundedJSON } from "./responses";
import { unitVector } from "./semantic-model";
import {
  checkedEmbeddingConfig,
  type EmbeddingConfig,
} from "./embedding-config";
export interface EmbeddingProvider {
  embed(
    inputs: string[],
    signal?: AbortSignal,
  ): Promise<{ vectors: number[][]; model: string; tokens: number | null }>;
}
export class AzureEmbeddingProvider implements EmbeddingProvider {
  private config: EmbeddingConfig;
  constructor(
    config: EmbeddingConfig,
    private fetcher: typeof fetch = fetch,
    private secrets: string[] = [],
  ) {
    this.config = checkedEmbeddingConfig(config);
  }
  async embed(inputs: string[], signal?: AbortSignal) {
    const c = this.config;
    if (
      !inputs.length ||
      inputs.length > 20 ||
      inputs.some(
        (v) => !v.trim() || new TextEncoder().encode(v).byteLength > 6000,
      )
    )
      throw new AppError(
        "INVALID_EMBEDDING_INPUT",
        "Choose 1–20 nonempty, bounded embedding inputs.",
        400,
      );
    const controller = new AbortController(),
      timer = setTimeout(() => controller.abort(), c.timeoutMs);
    try {
      const response = await this.fetcher(c.endpoint + "embeddings", {
        method: "POST",
        redirect: "manual",
        headers: { "Content-Type": "application/json", "api-key": c.key },
        signal: signal
          ? AbortSignal.any([controller.signal, signal])
          : controller.signal,
        body: JSON.stringify({
          model: c.deployment,
          input: inputs,
          encoding_format: "float",
          ...(c.requestDimensions ? { dimensions: c.dimensions } : {}),
        }),
      });
      if (!response.ok) {
        try {
          await response.body?.cancel();
        } catch {}
        throw new AppError(
          response.status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
          "The embedding provider did not confirm a result. No automatic retry was made.",
          response.status === 429 ? 429 : 502,
        );
      }
      const raw = await boundedJSON(response, 4194304);
      if (
        raw.object !== "list" ||
        !Array.isArray(raw.data) ||
        raw.data.length !== inputs.length ||
        typeof raw.model !== "string" ||
        !raw.model.trim() ||
        raw.model.length > 200 ||
        redact(raw.model, [c.key, ...this.secrets]) !== raw.model
      )
        throw new Error("Invalid embedding response");
      const vectors: number[][] = new Array(inputs.length),
        seen = new Set<number>();
      for (const item of raw.data) {
        if (
          item.object !== "embedding" ||
          !Number.isInteger(item.index) ||
          item.index < 0 ||
          item.index >= inputs.length ||
          seen.has(item.index) ||
          !Array.isArray(item.embedding) ||
          item.embedding.some((n: unknown) => typeof n !== "number")
        )
          throw new Error("Invalid embedding item");
        seen.add(item.index);
        vectors[item.index] = unitVector(item.embedding, c.dimensions);
      }
      return {
        vectors,
        model: raw.model,
        tokens:
          Number.isSafeInteger(raw.usage?.total_tokens) &&
          raw.usage.total_tokens >= 0
            ? raw.usage.total_tokens
            : null,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError(
        "EMBEDDING_UNCONFIRMED",
        "No valid embedding was confirmed. The provider may have processed the request. No retry was made.",
        502,
      );
    } finally {
      controller.abort();
      clearTimeout(timer);
    }
  }
}
