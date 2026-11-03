import type { Idea } from "../ideas/domain";
import { dimensions, type ActiveReviewer } from "./model";
import type { SavedReport } from "./reports";

export type RoundtableScore = {
  status: "ready" | "missing" | "incomplete" | "unavailable";
  score: number | null;
  ratings: Record<(typeof dimensions)[number], number | null>;
  reviewers: ActiveReviewer[];
  assessedReviewers: ActiveReviewer[];
  confidence: number | null;
  briefHash: string | null;
  updatedAt: string | null;
};
export function roundtableScore(
  idea: Idea,
  reports: SavedReport[] | null,
): RoundtableScore {
  const empty: RoundtableScore = {
    status: reports === null ? "unavailable" : "missing",
    score: null,
    ratings: { feasibility: null, success: null, value: null },
    reviewers: [],
    assessedReviewers: [],
    confidence: null,
    briefHash: null,
    updatedAt: null,
  };
  if (!reports || idea.canonicalIdeaId) return empty;
  const current = reports
    .filter(
      (r) =>
        r.snapshot.result.input.ideaId === idea.id &&
        r.snapshot.result.input.inputRevision === idea.revision,
    )
    .sort(
      (a, b) =>
        b.snapshot.result.completedAt.localeCompare(
          a.snapshot.result.completedAt,
        ) || b.snapshot.result.runId.localeCompare(a.snapshot.result.runId),
    );
  if (!current.length) return empty;
  // The latest completed assessment selects the brief. Never mix prompts or idea revisions.
  const latest = current[0].snapshot.result;
  const selected = new Map<ActiveReviewer, SavedReport>();
  for (const report of current) {
    const result = report.snapshot.result;
    if (result.inputHash !== latest.inputHash) continue;
    if (!selected.has(result.participant))
      selected.set(result.participant, report);
  }
  const values = [...selected.values()].map((r) => r.snapshot.result);
  const complete = values.filter((r) =>
    dimensions.every((d) => r.assessment.ratings[d].score !== null),
  );
  const meta = {
    ...empty,
    status: "incomplete" as const,
    briefHash: latest.inputHash,
    updatedAt: latest.completedAt,
    assessedReviewers: values.map((r) => r.participant),
  };
  // Unknown dimensions keep that reviewer unranked; do not fall back to an older run.
  if (!complete.length) return meta;
  const mean = (v: number[]) => v.reduce((a, b) => a + b, 0) / v.length;
  const ratings = Object.fromEntries(
    dimensions.map((d) => [
      d,
      Math.round(mean(complete.map((r) => r.assessment.ratings[d].score!))),
    ]),
  ) as RoundtableScore["ratings"];
  return {
    ...meta,
    status: "ready",
    score: Math.round(
      mean(
        complete.map((r) =>
          mean(dimensions.map((d) => r.assessment.ratings[d].score!)),
        ),
      ),
    ),
    ratings,
    reviewers: complete.map((r) => r.participant),
    confidence: mean(complete.map((r) => r.assessment.confidence)),
  };
}

export function applyRoundtableScore(
  idea: Idea,
  reports: SavedReport[] | null,
): Idea {
  const score = roundtableScore(idea, reports);
  return {
    ...idea,
    priorityScore: score.score,
    scoreAuthority: score.score === null ? null : "roundtable-provisional",
    confidence: score.confidence,
    roundtableScore: score,
  };
}
