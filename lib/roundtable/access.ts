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
export function gptProfile(config = gptConfig()) {
  return {
    ...aiProfile(config, promptVersion),
    localRetention:
      "The assessment stays in this browser until downloaded. The operation ledger retains hashes and request status, not idea excerpts or generated text.",
  };
}
export function roundtableService() {
  const config = gptConfig();
  const secrets = [
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
    new GPTReviewer(config, fetch, secrets),
    secrets,
  );
}
