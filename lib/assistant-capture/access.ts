import { notionConfig, operationalDB, envValue } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { AssistantCaptureService } from "./service";
import { AssistantCaptureStore } from "./store";
export function assistantCaptureService() {
  const db = operationalDB(),
    operations = new Operations(db);
  return new AssistantCaptureService(
    new NotionRepository(notionConfig()),
    operations,
    new AssistantCaptureStore(db, operations),
    [
      envValue("NOTION_TOKEN") ?? "",
      envValue("IDEA_LAB_AI_API_KEY") ?? "",
      envValue("IDEA_LAB_EMBEDDING_API_KEY") ?? "",
    ],
  );
}
