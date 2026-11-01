import type { AIConfig } from "../lib/intelligence/config";
import { aiEvaluationRequestSchema } from "../lib/intelligence/model";
import { draft } from "./assessment-fixtures";
import { idea, ids } from "./fixtures";
export const aiConfig: AIConfig = {
  provider: "azure-openai-responses",
  endpoint: "https://synthetic-resource.openai.azure.com/openai/v1/",
  deployment: "configured-deployment",
  key: "synthetic-model-key-not-real",
  maxOutputTokens: 4096,
  timeoutMs: 1000,
  requestsPerHour: 5,
  retentionNotice: "Synthetic service policy; no real transmission.",
};
export const command = aiEvaluationRequestSchema.parse({
  ideaId: ids.idea,
  inputRevision: idea.revision,
  selection: { summary: idea.summary },
  rubricVersion: draft.rubricVersion,
  weights: draft.weights,
});
