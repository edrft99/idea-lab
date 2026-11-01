import { envValue } from "../ideas/runtime";
import { checkedAIConfig } from "./config";
import { AppError } from "../ideas/errors";
import { digest } from "../ideas/operations";
import { inputVersion } from "./semantic-model";
export interface EmbeddingConfig {
  endpoint: string;
  deployment: string;
  key: string;
  dimensions: number;
  requestDimensions: boolean;
  versionLabel: string;
  retentionNotice: string;
  cacheSeconds: number;
  timeoutMs: number;
  requestsPerHour: number;
}
export function checkedEmbeddingConfig(c: EmbeddingConfig): EmbeddingConfig {
  try {
    // Share the existing HTTPS destination, credential and retention guard.
    const connection = checkedAIConfig({
      ...c,
      provider: "azure-openai-responses",
      maxOutputTokens: 2000,
    });
    if (
      !Number.isInteger(c.dimensions) ||
      c.dimensions < 1 ||
      c.dimensions > 4096 ||
      typeof c.requestDimensions !== "boolean" ||
      !c.versionLabel.trim() ||
      c.versionLabel.length > 100 ||
      !Number.isInteger(c.cacheSeconds) ||
      c.cacheSeconds < 3600 ||
      c.cacheSeconds > 604800
    )
      throw new Error("Invalid embedding configuration");
    return { ...c, endpoint: connection.endpoint };
  } catch {
    throw new AppError(
      "EMBEDDING_CONFIGURATION_REQUIRED",
      "Semantic search needs a protected embedding endpoint, deployment/key, dimensions, version label and retention policy.",
      503,
    );
  }
}
export function embeddingConfig() {
  return checkedEmbeddingConfig({
    endpoint: envValue("IDEA_LAB_EMBEDDING_ENDPOINT") ?? "",
    deployment: envValue("IDEA_LAB_EMBEDDING_DEPLOYMENT") ?? "",
    key: envValue("IDEA_LAB_EMBEDDING_API_KEY") ?? "",
    dimensions: Number(envValue("IDEA_LAB_EMBEDDING_DIMENSIONS")),
    requestDimensions:
      envValue("IDEA_LAB_EMBEDDING_REQUEST_DIMENSIONS") === "true",
    versionLabel: envValue("IDEA_LAB_EMBEDDING_VERSION") ?? "",
    retentionNotice: envValue("IDEA_LAB_EMBEDDING_RETENTION_NOTICE") ?? "",
    cacheSeconds: Number(
      envValue("IDEA_LAB_EMBEDDING_CACHE_SECONDS") ?? 604800,
    ),
    timeoutMs: Number(envValue("IDEA_LAB_EMBEDDING_TIMEOUT_MS") ?? 45000),
    requestsPerHour: Number(envValue("IDEA_LAB_AI_REQUESTS_PER_HOUR") ?? 5),
  });
}
export function embeddingProfile(c: EmbeddingConfig) {
  return {
    endpoint: c.endpoint,
    deployment: c.deployment,
    dimensions: c.dimensions,
    requestDimensions: c.requestDimensions,
    versionLabel: c.versionLabel,
    inputVersion,
    retentionNotice: c.retentionNotice,
    cacheSeconds: c.cacheSeconds,
    timeoutMs: c.timeoutMs,
    requestsPerHour: c.requestsPerHour,
  };
}
export function embeddingProfileHash(c: EmbeddingConfig) {
  return digest(
    JSON.stringify([
      c.endpoint,
      c.deployment,
      c.dimensions,
      c.versionLabel,
      inputVersion,
      "f32le-v1",
    ]),
  );
}
