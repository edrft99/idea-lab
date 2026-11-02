import type { AIConfig } from "./config";
import { envValue } from "../ideas/runtime";
import { AppError } from "../ideas/errors";
export type OpenAIConfig = Omit<AIConfig, "provider"> & {
  provider: "openai-responses";
};
export function checkedOpenAIConfig(value: OpenAIConfig): OpenAIConfig {
  if (
    value.provider !== "openai-responses" ||
    value.endpoint !== "https://api.openai.com/v1/" ||
    !value.key.trim() ||
    /[\r\n]/.test(value.key) ||
    !value.deployment.trim() ||
    value.deployment.length > 200 ||
    /[\r\n]/.test(value.deployment) ||
    !value.retentionNotice.trim() ||
    value.retentionNotice.length > 2000 ||
    !Number.isInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 2000 ||
    value.maxOutputTokens > 8000 ||
    !Number.isInteger(value.timeoutMs) ||
    value.timeoutMs < 1000 ||
    value.timeoutMs > 60000 ||
    !Number.isInteger(value.requestsPerHour) ||
    value.requestsPerHour < 1 ||
    value.requestsPerHour > 100
  )
    throw new AppError(
      "GPT_CONFIGURATION_REQUIRED",
      "GPT needs a model, API key and retention notice in protected site settings.",
      503,
    );
  return { ...value };
}
export function openAIConfig(): OpenAIConfig {
  return checkedOpenAIConfig({
    provider: "openai-responses",
    endpoint: "https://api.openai.com/v1/",
    deployment: envValue("IDEA_LAB_GPT_MODEL") ?? "",
    key: envValue("IDEA_LAB_GPT_API_KEY") ?? "",
    retentionNotice: envValue("IDEA_LAB_GPT_RETENTION_NOTICE") ?? "",
    maxOutputTokens: Number(envValue("IDEA_LAB_GPT_MAX_OUTPUT_TOKENS") ?? 4096),
    timeoutMs: Number(envValue("IDEA_LAB_GPT_TIMEOUT_MS") ?? 45000),
    requestsPerHour: Number(envValue("IDEA_LAB_AI_REQUESTS_PER_HOUR") ?? 5),
  });
}
