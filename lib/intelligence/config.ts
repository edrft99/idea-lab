import { envValue } from "../ideas/runtime";
import { AppError } from "../ideas/errors";
export const promptVersion = "assessment-v1" as const;
export interface AIConfig {
  provider: "azure-openai-responses";
  endpoint: string;
  deployment: string;
  key: string;
  maxOutputTokens: number;
  timeoutMs: number;
  requestsPerHour: number;
  retentionNotice: string;
}
const invalid = () =>
  new AppError(
    "AI_CONFIGURATION_REQUIRED",
    "AI assessment is unavailable until its protected endpoint, deployment, key and retention notice are configured.",
    503,
  );
export function checkedAIConfig(value: AIConfig): AIConfig {
  try {
    const u = new URL(value.endpoint);
    if (
      value.provider !== "azure-openai-responses" ||
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      u.search ||
      u.hash ||
      !/^[a-z0-9][a-z0-9-]{0,62}\.(openai\.azure\.com|services\.ai\.azure\.com)$/.test(
        u.hostname,
      ) ||
      !["/openai/v1", "/openai/v1/"].includes(u.pathname) ||
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
      throw new Error("Invalid");
    return { ...value, endpoint: u.origin + "/openai/v1/" };
  } catch {
    throw invalid();
  }
}
export function aiConfig(): AIConfig {
  if (envValue("IDEA_LAB_AI_PROVIDER") !== "azure-openai-responses")
    throw invalid();
  return checkedAIConfig({
    provider: "azure-openai-responses",
    endpoint: envValue("IDEA_LAB_AI_ENDPOINT") ?? "",
    deployment: envValue("IDEA_LAB_AI_DEPLOYMENT") ?? "",
    key: envValue("IDEA_LAB_AI_API_KEY") ?? "",
    retentionNotice: envValue("IDEA_LAB_AI_RETENTION_NOTICE") ?? "",
    maxOutputTokens: Number(envValue("IDEA_LAB_AI_MAX_OUTPUT_TOKENS") ?? 4096),
    timeoutMs: Number(envValue("IDEA_LAB_AI_TIMEOUT_MS") ?? 45000),
    requestsPerHour: Number(envValue("IDEA_LAB_AI_REQUESTS_PER_HOUR") ?? 5),
  });
}
export function aiProfile(
  c:
    | AIConfig
    | import("./openai-config").OpenAIConfig
    | import("../roundtable/claude-config").ClaudeConfig,
  taskPromptVersion: string = promptVersion,
) {
  return {
    provider: c.provider,
    endpoint: c.endpoint,
    deployment: c.deployment,
    promptVersion: taskPromptVersion,
    maxOutputTokens: c.maxOutputTokens,
    timeoutMs: c.timeoutMs,
    requestsPerHour: c.requestsPerHour,
    retentionNotice: c.retentionNotice,
    requestStorage:
      c.provider === "anthropic-messages"
        ? "Anthropic Messages API; no prompt caching requested. Retention follows your Anthropic account policy; no zero-retention guarantee is made."
        : "store=false requested; provider retention and abuse monitoring still follow the configured service policy.",
    localRetention:
      "The generated result stays in this browser until downloaded or explicitly saved for Notion review. The operation ledger stores hashes only.",
  };
}
