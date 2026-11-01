import { envValue, notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { aiConfig } from "./config";
import { AzureResponsesExtraction } from "./extraction-provider";
import { AIExtractionService } from "./extraction-service";
export function aiExtractionService() {
  const c = aiConfig(),
    secrets = [
      envValue("NOTION_TOKEN") ?? "",
      envValue("IDEA_LAB_EMBEDDING_API_KEY") ?? "",
    ];
  return new AIExtractionService(
    c,
    new Operations(operationalDB()),
    new AzureResponsesExtraction(c, fetch, secrets),
    () => new NotionRepository(notionConfig()),
    secrets,
  );
}
