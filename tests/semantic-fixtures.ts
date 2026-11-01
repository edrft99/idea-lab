import { vi } from "vitest";
import { SemanticService } from "../lib/intelligence/semantic-service";
import { SemanticCache } from "../lib/intelligence/semantic-cache";
import { Operations } from "../lib/ideas/operations";
import type { NotionRepository } from "../lib/ideas/notion";
import type { EmbeddingConfig } from "../lib/intelligence/embedding-config";
import {
  indexCommandSchema,
  queryCommandSchema,
} from "../lib/intelligence/semantic-model";
import { idea, memoryDB } from "./fixtures";
export const embeddingConfig: EmbeddingConfig = {
  endpoint: "https://synthetic.openai.azure.com/openai/v1/",
  deployment: "embedding-fixture",
  key: "synthetic-embedding-secret",
  dimensions: 3,
  requestDimensions: false,
  versionLabel: "pinned-fixture-v1",
  retentionNotice: "Synthetic policy; fixture only.",
  cacheSeconds: 3600,
  timeoutMs: 1000,
  requestsPerHour: 100,
};
export const indexCommand = indexCommandSchema.parse({
  records: [{ id: idea.id, expectedRevision: idea.revision }],
  fields: ["title", "summary"],
});
export const queryCommand = queryCommandSchema.parse({
  query: "portable sensor",
  filters: {},
  threshold: 0.5,
  limit: 10,
});
export function setupSemantic(config: Partial<EmbeddingConfig> = {}) {
  const memory = memoryDB(),
    operations = new Operations(memory.db),
    cache = new SemanticCache(memory.db),
    records = [structuredClone(idea)];
  const repository = {
    getSemanticIdea: vi.fn(async (id: string) => {
      const r = records.find((i) => i.id === id);
      if (!r) throw new Error("Deleted fixture");
      return structuredClone(r);
    }),
    list: vi.fn(async () => structuredClone(records)),
    listSemanticIdeas: vi.fn(async () =>
      structuredClone(records.filter((r) => !r.canonicalIdeaId)),
    ),
  };
  const provider = {
    embed: vi.fn(async (inputs: string[]) => ({
      vectors: inputs.map(() => [3, 4, 0]),
      model: "embedding-model-v1",
      tokens: 5,
    })),
  };
  const service = new SemanticService(
    { ...embeddingConfig, ...config },
    repository as unknown as NotionRepository,
    operations,
    cache,
    provider,
  );
  return { memory, operations, cache, records, repository, provider, service };
}
