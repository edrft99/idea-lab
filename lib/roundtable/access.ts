import { grokConfig } from "./grok-config";
import { GrokReviewer } from "./grok-provider";
import { claudeConfig } from "./claude-config";
import { ClaudeReviewer } from "./claude-provider";
import type { ActiveReviewer } from "./model";
import { RoundtableReports, RoundtableReportService } from "./reports";
import { envValue, notionConfig, operationalDB } from "../ideas/runtime";
import { NotionRepository } from "../ideas/notion";
import { Operations } from "../ideas/operations";
import { aiConfig, aiProfile } from "../intelligence/config";
import { openAIConfig } from "../intelligence/openai-config";
import { AppError } from "../ideas/errors";
import { GPTReviewer } from "./provider";
import { RoundtableService } from "./service";
import { promptVersion } from "./model";
export function gptConfig() {
  const provider = envValue("IDEA_LAB_GPT_PROVIDER");
  if (provider === "openai-responses") return openAIConfig();
  if (provider === "azure-openai-responses") return aiConfig();
  throw new AppError(
    "GPT_CONFIGURATION_REQUIRED",
    "GPT is not connected. Configure its provider, model, API key and retention notice in protected site settings.",
    503,
  );
}
const gptReportRetention =
  "Completed assessments are automatically saved to Notion. The operation ledger retains hashes and request status; Notion retains the full report and selected brief.";
export function gptProfile(config = gptConfig()) {
  return {
    ...aiProfile(config, promptVersion),
    localRetention: gptReportRetention,
  };
}
export function claudeProfile() {
  return {
    ...aiProfile(claudeConfig(), promptVersion),
    localRetention: gptReportRetention,
  };
}
export function grokProfile() {
  return {
    ...aiProfile(grokConfig(), promptVersion),
    localRetention: gptReportRetention,
  };
}
export function roundtableService(reviewer: ActiveReviewer = "gpt") {
  const config =
    reviewer === "grok"
      ? grokConfig()
      : reviewer === "claude"
        ? claudeConfig()
        : gptConfig();
  const secrets = [
    "IDEA_LAB_GROK_API_KEY",
    "IDEA_LAB_CLAUDE_API_KEY",
    "NOTION_TOKEN",
    "IDEA_LAB_AI_API_KEY",
    "IDEA_LAB_EMBEDDING_API_KEY",
    "IDEA_LAB_GPT_API_KEY",
    "IDEA_LAB_CLAUDE_RELAY_KEY",
  ].map((key) => envValue(key) ?? "");
  return new RoundtableService(
    config,
    new NotionRepository(notionConfig()),
    new Operations(operationalDB()),
    config.provider === "xai-chat-completions"
      ? new GrokReviewer(config, fetch, secrets)
      : config.provider === "anthropic-messages"
        ? new ClaudeReviewer(config, fetch, secrets)
        : new GPTReviewer(config, fetch, secrets),
    roundtableReportService(),
    secrets,
  );
}

export function roundtableReports() {
  return new RoundtableReports(notionConfig());
}
export function roundtableReportService() {
  return new RoundtableReportService(
    roundtableReports(),
    new Operations(operationalDB()),
  );
}
