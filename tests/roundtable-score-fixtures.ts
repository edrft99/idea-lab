import { idea } from "./fixtures";
import { assessment, roundtableCommand } from "./roundtable-fixtures";
import { resultSchema, type ActiveReviewer } from "../lib/roundtable/model";
import type { SavedReport } from "../lib/roundtable/reports";
export function scoreReport(
  reviewer: ActiveReviewer,
  scores: [number | null, number | null, number | null],
  minute = 1,
  brief = "a",
  revision = idea.revision,
): SavedReport {
  return {
    id: "70000000-0000-4000-8000-000000000007",
    url: null,
    snapshot: {
      format: "idea-lab-roundtable-report",
      version: 1,
      operation: "d".repeat(64),
      ownerHash: "e".repeat(64),
      approvedAt: "2026-11-03T11:00:00Z",
      resultHash: "f".repeat(64),
      result: resultSchema.parse({
        format: "idea-lab-roundtable",
        version: 1,
        runId:
          (reviewer === "gpt" ? "1" : reviewer === "claude" ? "2" : "3") +
          String(minute).padStart(63, "0"),
        participant: reviewer,
        stage: "independent",
        input: { ...roundtableCommand, inputRevision: revision },
        inputHash: brief.repeat(64),
        assessment: {
          ...assessment,
          ratings: {
            feasibility: { score: scores[0], evidence: "Synthetic evidence." },
            success: { score: scores[1], evidence: "Synthetic evidence." },
            value: { score: scores[2], evidence: "Synthetic evidence." },
          },
        },
        provider:
          reviewer === "gpt"
            ? "openai-responses"
            : reviewer === "claude"
              ? "anthropic-messages"
              : "xai-chat-completions",
        model: "synthetic",
        resolvedModel: "synthetic",
        endpoint: "https://synthetic.test/",
        responseId: "synthetic",
        rubricVersion: "viability-v1",
        promptVersion: "roundtable-independent-v1",
        requestedAt: "2026-11-03T10:00:00Z",
        completedAt: `2026-11-03T10:${String(minute).padStart(2, "0")}:00Z`,
        usage: null,
      }),
    },
  };
}
