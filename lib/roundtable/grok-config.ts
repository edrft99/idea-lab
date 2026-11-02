import type { AIConfig } from "../intelligence/config";
import { envValue } from "../ideas/runtime";
import { AppError } from "../ideas/errors";

export type GrokConfig = Omit<AIConfig, "provider"> & {
  provider: "xai-chat-completions";
};
export function checkedGrokConfig(c: GrokConfig): GrokConfig {
  if (
    c.provider !== "xai-chat-completions" ||
    c.endpoint !== "https://api.x.ai/v1/" ||
    !c.key.trim() ||
    /[\r\n]/.test(c.key) ||
    !c.deployment.trim() ||
    c.deployment.length > 200 ||
    /[\r\n]/.test(c.deployment) ||
    !c.retentionNotice.trim() ||
    c.retentionNotice.length > 2000 ||
    !Number.isInteger(c.maxOutputTokens) ||
    c.maxOutputTokens < 2000 ||
    c.maxOutputTokens > 8000 ||
    !Number.isInteger(c.timeoutMs) ||
    c.timeoutMs < 1000 ||
    c.timeoutMs > 60000 ||
    !Number.isInteger(c.requestsPerHour) ||
    c.requestsPerHour < 1 ||
    c.requestsPerHour > 100
  )
    throw new AppError(
      "GROK_CONFIGURATION_REQUIRED",
      "Grok needs a model, xAI API key and retention notice in protected site settings.",
      503,
    );
  return { ...c };
}
export function grokConfig(): GrokConfig {
  return checkedGrokConfig({
    provider: "xai-chat-completions",
    endpoint: "https://api.x.ai/v1/",
    deployment: envValue("IDEA_LAB_GROK_MODEL") ?? "",
    key: envValue("IDEA_LAB_GROK_API_KEY") ?? "",
    retentionNotice: envValue("IDEA_LAB_GROK_RETENTION_NOTICE") ?? "",
    maxOutputTokens: Number(
      envValue("IDEA_LAB_GROK_MAX_OUTPUT_TOKENS") ?? 4096,
    ),
    timeoutMs: Number(envValue("IDEA_LAB_GROK_TIMEOUT_MS") ?? 45000),
    requestsPerHour: Number(envValue("IDEA_LAB_AI_REQUESTS_PER_HOUR") ?? 5),
  });
}
