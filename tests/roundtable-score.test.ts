import { scoreReport as report } from "./roundtable-score-fixtures";
import { describe, it, expect, vi } from "vitest";
import { idea } from "./fixtures";
import { applyRoundtableScore, roundtableScore } from "../lib/roundtable/score";
import { scoredIdeas } from "../lib/roundtable/scored-ideas";
import { filterIdeas } from "../lib/ideas/domain";

describe("provisional roundtable Potential score", () => {
  it("averages dimensions and reviewers equally without double rounding", () => {
    const score = roundtableScore(idea, [
      report("gpt", [0, 0, 1]),
      report("claude", [0, 0, 2]),
      report("grok", [0, 0, 1]),
    ]);
    expect(score.score).toBe(0); // 4/9, not mean(round(1/3),round(2/3),round(1/3)).
    expect(score.reviewers).toHaveLength(3);
    expect(score.ratings.value).toBe(1);
  });
  it("supports one reviewer and scores of zero or one hundred", () => {
    expect(roundtableScore(idea, [report("gpt", [70, 40, 60])]).score).toBe(57);
    expect(roundtableScore(idea, [report("gpt", [0, 0, 0])]).score).toBe(0);
    expect(roundtableScore(idea, [report("grok", [100, 100, 100])]).score).toBe(
      100,
    );
  });
  it("uses only the latest run per reviewer, not its number of saved reports", () => {
    const score = roundtableScore(idea, [
      report("gpt", [0, 0, 0], 1),
      report("gpt", [90, 90, 90], 3),
      report("claude", [30, 30, 30], 2),
    ]);
    expect(score.score).toBe(60);
    expect(score.reviewers).toHaveLength(2);
  });
  it("selects the latest completed brief and never mixes different prompts", () => {
    const score = roundtableScore(idea, [
      report("gpt", [90, 90, 90], 1),
      report("claude", [90, 90, 90], 2),
      report("grok", [30, 30, 30], 3, "b"),
    ]);
    expect(score.score).toBe(30);
    expect(score.reviewers).toEqual(["grok"]);
    expect(score.briefHash).toBe("b".repeat(64));
  });
  it("ignores older idea revisions and reports for a different idea", () => {
    const wrong = report("claude", [100, 100, 100], 3);
    wrong.snapshot.result.input.ideaId = "90000000-0000-4000-8000-000000000009";
    expect(
      roundtableScore(idea, [
        wrong,
        report("gpt", [100, 100, 100], 2, "b", "old"),
        report("grok", [40, 40, 40], 1),
      ]).score,
    ).toBe(40);
    expect(
      roundtableScore(idea, [report("gpt", [100, 100, 100], 2, "b", "old")])
        .status,
    ).toBe("missing");
  });
  it("excludes an incomplete reviewer instead of treating null as zero or reusing an older run", () => {
    const score = roundtableScore(idea, [
      report("gpt", [100, 100, 100], 1),
      report("gpt", [null, 90, 90], 3),
      report("claude", [40, 50, 60], 2),
    ]);
    expect(score.score).toBe(50);
    expect(score.reviewers).toEqual(["claude"]);
    expect(score.assessedReviewers).toHaveLength(2);
    expect(roundtableScore(idea, [report("gpt", [null, 90, 90])]).status).toBe(
      "incomplete",
    );
  });
  it("never falls back to an old manual score and leaves the source idea unchanged", () => {
    const manual = {
      ...idea,
      priorityScore: 99,
      scoreAuthority: "manual-approved",
    };
    expect(applyRoundtableScore(manual, []).priorityScore).toBeNull();
    expect(applyRoundtableScore(manual, null).roundtableScore?.status).toBe(
      "unavailable",
    );
    expect(manual.priorityScore).toBe(99);
    expect(
      applyRoundtableScore(manual, [report("gpt", [40, 40, 40])])
        .scoreAuthority,
    ).toBe("roundtable-provisional");
  });
  it("does not rank a merged original", () => {
    expect(
      roundtableScore(
        { ...idea, canonicalIdeaId: "90000000-0000-4000-8000-000000000009" },
        [report("gpt", [90, 90, 90])],
      ).score,
    ).toBeNull();
  });
});
describe("roundtable score read projection", () => {
  it("batches source reads and applies score filtering and sorting after projection", async () => {
    const second = {
      ...idea,
      id: "90000000-0000-4000-8000-000000000009",
      priorityScore: 100,
    };
    const load = vi.fn().mockResolvedValue(
      new Map([
        [idea.id, [report("gpt", [80, 80, 80])]],
        [second.id, []],
      ]),
    );
    const result = await scoredIdeas(
      [{ ...idea, priorityScore: null }, second],
      "owner",
      load,
    );
    expect(load).toHaveBeenCalledExactlyOnceWith([idea.id, second.id], "owner");
    expect(
      filterIdeas(result, { sort: "score", minScore: 70 }).map((i) => i.id),
    ).toEqual([idea.id]);
    expect(filterIdeas(result, { sort: "score" })[1].priorityScore).toBeNull();
  });
  it("marks unavailable reports honestly while preserving unrelated valid scores", async () => {
    const second = { ...idea, id: "90000000-0000-4000-8000-000000000009" };
    const result = await scoredIdeas(
      [idea, second],
      "owner",
      async () =>
        new Map([
          [idea.id, [report("gpt", [80, 80, 80])]],
          [second.id, null],
        ]),
    );
    expect(result[0].priorityScore).toBe(80);
    expect(result[1].roundtableScore?.status).toBe("unavailable");
    expect(
      (
        await scoredIdeas([idea], "owner", async () => {
          throw new Error("Synthetic outage");
        })
      )[0].roundtableScore?.status,
    ).toBe("unavailable");
  });
});
