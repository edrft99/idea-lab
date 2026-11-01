import { SnapshotCoordinator } from "./snapshot-coordinator";
import { SnapshotService } from "./snapshot-service";
import { envValue, notionConfig, operationalDB } from "../ideas/runtime";
import { Operations } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { SemanticCache } from "./semantic-cache";
import { SemanticService } from "./semantic-service";
import { embeddingConfig } from "./embedding-config";
import { AzureEmbeddingProvider } from "./embedding-provider";
export function semanticCoordinator() {
  const db = operationalDB();
  return new SnapshotCoordinator(new Operations(db), new SemanticCache(db));
}
export function semanticService() {
  const c = embeddingConfig(),
    db = operationalDB(),
    secrets = [
      envValue("NOTION_TOKEN") ?? "",
      envValue("IDEA_LAB_AI_API_KEY") ?? "",
    ];
  return new SemanticService(
    c,
    new NotionRepository(notionConfig()),
    new Operations(db),
    new SemanticCache(db),
    new AzureEmbeddingProvider(c, fetch, secrets),
    secrets,
  );
}

export function snapshotService() {
  const c = embeddingConfig(),
    db = operationalDB(),
    secrets = [
      envValue("NOTION_TOKEN") ?? "",
      envValue("IDEA_LAB_AI_API_KEY") ?? "",
    ];
  return new SnapshotService(
    c,
    new NotionRepository(notionConfig()),
    new Operations(db),
    new SemanticCache(db),
    new AzureEmbeddingProvider(c, fetch, secrets),
    secrets,
  );
}
