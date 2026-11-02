import type { AIConfig } from "../intelligence/config";
import { envValue } from "../ideas/runtime";
import { AppError } from "../ideas/errors";

export type ClaudeConfig = Omit<AIConfig, "provider"> & {
  provider: "anthropic-messages";
};
export function checkedClaudeConfig(c: ClaudeConfig): ClaudeConfig {
  if (
    c.provider !== "anthropic-messages" ||
    c.endpoint !== "https://api.anthropic.com/v1/" ||
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
      "CLAUDE_CONFIGURATION_REQUIRED",
      "Claude needs a model, Anthropic API key and retention notice in protected site settings.",
      503,
    );
  return { ...c };
}
export function claudeConfig(): ClaudeConfig {
  return checkedClaudeConfig({
    provider: "anthropic-messages",
    endpoint: "https://api.anthropic.com/v1/",
    deployment: envValue("IDEA_LAB_CLAUDE_MODEL") ?? "",
    key: envValue("IDEA_LAB_CLAUDE_API_KEY") ?? "",
    retentionNotice: envValue("IDEA_LAB_CLAUDE_RETENTION_NOTICE") ?? "",
    maxOutputTokens: Number(
      envValue("IDEA_LAB_CLAUDE_MAX_OUTPUT_TOKENS") ?? 4096,
    ),
    timeoutMs: Number(envValue("IDEA_LAB_CLAUDE_TIMEOUT_MS") ?? 45000),
    requestsPerHour: Number(envValue("IDEA_LAB_AI_REQUESTS_PER_HOUR") ?? 5),
  });
}
