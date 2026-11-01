import { describe, it, expect } from "vitest";
import {
  editableIdeaSchema,
  scoreFromRatings,
  filterIdeas,
} from "../lib/ideas/domain";
import { input, idea } from "./fixtures";
describe("shared idea contract", () => {
  it("keeps ratings separate and maps 1–5 to 0–100", () => {
    expect(
      scoreFromRatings({
        impact: 1,
        alignment: 1,
        feasibility: 1,
        reusability: 1,
        timing: 1,
      }),
    ).toBe(0);
    expect(
      scoreFromRatings({
        impact: 5,
        alignment: 5,
        feasibility: 5,
        reusability: 5,
        timing: 5,
      }),
    ).toBe(100);
    expect(scoreFromRatings(idea.scores)).toBeNull();
  });
  it("rejects score overrides and unknown keys in normal editing", () => {
    expect(
      editableIdeaSchema.safeParse({ ...input, priorityScore: 100 }).success,
    ).toBe(false);
    expect(
      editableIdeaSchema.safeParse({ ...input, in_trash: true }).success,
    ).toBe(false);
  });
  it("rejects unsafe project links", () =>
    expect(
      editableIdeaSchema.safeParse({
        ...input,
        projectUrl: "javascript:alert(1)",
      }).success,
    ).toBe(false));
  it("combines keyword, source, effort and score filters", () => {
    const i = {
      ...idea,
      priorityScore: 90,
      effort: "Weekend" as const,
      sources: [
        {
          id: "s",
          system: "Manual",
          identifier: "m",
          url: null,
          conversationDate: null,
          capturedDate: null,
          summary: "",
          ideaIds: [idea.id],
        },
      ],
    };
    expect(
      filterIdeas([i], {
        query: "SENSOR",
        source: "Manual",
        effort: "Weekend",
        minScore: 80,
        sort: "score",
      }),
    ).toHaveLength(1);
    expect(filterIdeas([idea], { minScore: 0, sort: "score" })).toHaveLength(0);
  });
});
