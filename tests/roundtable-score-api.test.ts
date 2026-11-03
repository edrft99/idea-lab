import { describe, it, expect, vi, beforeEach } from "vitest";
vi.mock("@/lib/ideas/access", () => ({
  authorizeOwner: vi.fn(),
  repository: vi.fn(),
}));
vi.mock("@/lib/roundtable/access", () => ({
  roundtableReportService: vi.fn(),
}));
import { authorizeOwner, repository } from "../lib/ideas/access";
import { roundtableReportService } from "../lib/roundtable/access";
import { GET as list } from "../app/api/ideas/route";
import { GET as dashboard } from "../app/api/dashboard/route";
import { GET as detail } from "../app/api/ideas/[id]/route";
import { filterIdeas, type IdeaFilter } from "../lib/ideas/domain";
import { idea } from "./fixtures";
import { scoreReport } from "./roundtable-score-fixtures";
import { AppError } from "../lib/ideas/errors";
const second = {
  ...idea,
  id: "90000000-0000-4000-8000-000000000009",
  title: "Unreviewed synthetic idea",
  priorityScore: 100,
};
const repo = { list: vi.fn(), reviews: vi.fn(), detail: vi.fn() };
const history = { scoreReports: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(authorizeOwner).mockResolvedValue({ userId: "owner" } as any);
  vi.mocked(repository).mockReturnValue(repo as any);
  vi.mocked(roundtableReportService).mockReturnValue(history as any);
  repo.list.mockImplementation(async (filter: IdeaFilter) =>
    filterIdeas([{ ...idea, priorityScore: null }, second], filter),
  );
  repo.reviews.mockResolvedValue([]);
  repo.detail.mockResolvedValue({
    idea,
    mergedIdeas: [],
    evaluations: [],
    relatedIdeas: [],
    relatedTotal: 0,
    reviews: [],
  });
  history.scoreReports.mockResolvedValue(
    new Map([
      [idea.id, [scoreReport("gpt", [80, 80, 80])]],
      [second.id, []],
    ]),
  );
});
describe("Potential scores in site read APIs", () => {
  it("filters by the roundtable score after loading an idea whose legacy score is blank", async () => {
    const response = await list(
      new Request("https://idea.test/api/ideas?minScore=70"),
    );
    expect(response.status).toBe(200);
    const { data } = (await response.json()) as any;
    expect(data.map((v: any) => v.id)).toEqual([idea.id]);
    expect(data[0].priorityScore).toBe(80);
    expect(repo.list).toHaveBeenCalledWith({
      sort: "score",
      minScore: undefined,
    });
    expect(history.scoreReports).toHaveBeenCalledOnce();
  });
  it("uses the same provisional score and order on the dashboard", async () => {
    const { data } = (await (await dashboard()).json()) as any;
    expect(data.ideas[0].id).toBe(idea.id);
    expect(data.ideas[0].priorityScore).toBe(80);
    expect(data.ideas[0].scoreAuthority).toBe("roundtable-provisional");
    expect(data.ideas[1].priorityScore).toBeNull();
  });
  it("includes the detail breakdown and preserves manual evaluation history", async () => {
    repo.detail.mockResolvedValue({
      idea,
      evaluations: [{ id: "synthetic-old-evaluation" }],
      relatedIdeas: [],
      relatedTotal: 0,
      reviews: [],
    });
    const response = await detail(
      new Request("https://idea.test/api/ideas/" + idea.id),
      { params: Promise.resolve({ id: idea.id }) },
    );
    const { data } = (await response.json()) as any;
    expect(data.idea.roundtableScore.ratings).toEqual({
      feasibility: 80,
      success: 80,
      value: 80,
    });
    expect(data.evaluations).toEqual([{ id: "synthetic-old-evaluation" }]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
  it("requires owner authentication before fetching any report", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(authorizeOwner).mockRejectedValue(
      new AppError("UNAUTHENTICATED", "Sign in.", 401),
    );
    expect((await dashboard()).status).toBe(401);
    expect(history.scoreReports).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
