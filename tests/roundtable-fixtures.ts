import { assessmentSchema, requestSchema } from "../lib/roundtable/model";
import type { OpenAIConfig } from "../lib/intelligence/openai-config";
import { idea } from "./fixtures";
export const gptConfig: OpenAIConfig = {
  provider: "openai-responses",
  endpoint: "https://api.openai.com/v1/",
  deployment: "synthetic-gpt",
  key: "synthetic-key-not-real",
  retentionNotice: "Synthetic policy; no live transmission.",
  maxOutputTokens: 4096,
  timeoutMs: 1000,
  requestsPerHour: 5,
};
export const roundtableCommand = requestSchema.parse({
  ideaId: idea.id,
  inputRevision: idea.revision,
  selection: { summary: idea.summary },
  successCriteria:
    "Help 20 synthetic users save an hour weekly in three months.",
  constraints: "One developer, six weekends and a £300 budget.",
  rubricVersion: "viability-v1",
});
export const assessment = assessmentSchema.parse({
  verdict: "Needs validation",
  summary: "A plausible synthetic idea with untested demand.",
  ratings: {
    feasibility: {
      score: 70,
      evidence: "A limited prototype fits the constraints.",
    },
    success: { score: 40, evidence: "No adoption evidence is supplied." },
    value: {
      score: 60,
      evidence: "Time savings could be useful if demonstrated.",
    },
  },
  confidence: 0.4,
  strengths: ["A bounded prototype is possible."],
  risks: ["The audience may not use it."],
  assumptions: ["Users perform this task often."],
  expansions: ["Test a narrower workflow first."],
  experiments: [
    {
      experiment: "Interview five synthetic target users.",
      successSignal: "Three describe the problem without prompting.",
    },
  ],
});
export function responseBody(value: unknown = assessment) {
  return {
    object: "response",
    id: "synthetic-response",
    model: "synthetic-gpt-resolved",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 200 },
    output: [
      {
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: JSON.stringify(value) }],
      },
    ],
  };
}
