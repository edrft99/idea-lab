import type { Idea } from "../ideas/domain";
import type { SavedReport } from "./reports";
import { roundtableReportService } from "./access";
import { applyRoundtableScore } from "./score";

// Read-only score projection: Notion reports stay authoritative; no idea writes or model calls.
export async function scoredIdeas(
  ideas: Idea[],
  actor: string,
  load = (
    ids: string[],
    owner: string,
  ): Promise<Map<string, SavedReport[] | null>> =>
    roundtableReportService().scoreReports(ids, owner),
): Promise<Idea[]> {
  if (!ideas.length) return [];
  try {
    const histories = await load(
      ideas.map((i) => i.id),
      actor,
    );
    return ideas.map((i) =>
      applyRoundtableScore(i, histories.get(i.id) ?? null),
    );
  } catch {
    return ideas.map((i) => applyRoundtableScore(i, null));
  }
}
