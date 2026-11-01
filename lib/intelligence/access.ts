import { envValue, notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { aiConfig } from "./config";
import { AzureResponsesAssessment } from "./provider";
import { AIAssessmentService } from "./service";
export function aiAssessmentService() {
  const config = aiConfig(),
    secrets = [
      envValue("NOTION_TOKEN") ?? "",
      envValue("IDEA_LAB_EMBEDDING_API_KEY") ?? "",
    ];
  return new AIAssessmentService(
    config,
    new NotionRepository(notionConfig()),
    new Operations(operationalDB()),
    new AzureResponsesAssessment(config, fetch, secrets),
    secrets,
  );
}
