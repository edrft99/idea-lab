import { z } from "zod";
import { importSourceSchema } from "../imports/provenance";
export const statuses = [
  "Inbox",
  "Evaluating",
  "Exploring",
  "Planned",
  "Active",
  "Completed",
  "Parked",
  "Archived",
] as const;
export const categories = [
  "AI & Agents",
  "Developer Tools",
  "Hardware & IoT",
  "Automation",
  "Content & Learning",
] as const;
export const systems = [
  "ChatGPT",
  "Claude",
  "Claude Code",
  "Codex",
  "Notion",
  "GitHub",
  "Manual",
] as const;
export const efforts = ["Weekend", "1–2 weeks", "1 month+", "Unknown"] as const;
export const readinessOptions = [
  "Discovery",
  "Ready to explore",
  "Ready to build",
] as const;
const text = z.string().trim().max(6000);
const safeUrl = z
  .string()
  .url()
  .refine((v) => {
    try {
      return ["http:", "https:"].includes(new URL(v).protocol);
    } catch {
      return false;
    }
  }, "Use an HTTP(S) URL");
export const editableIdeaSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    summary: z.string().trim().min(1).max(2000),
    problem: text.default(""),
    solution: text.default(""),
    audience: text.default(""),
    expectedValue: text.default(""),
    context: text.default(""),
    category: z.enum(categories),
    status: z.enum(statuses).default("Inbox"),
    effort: z.enum(efforts).default("Unknown"),
    readiness: z.enum(readinessOptions).default("Discovery"),
    nextAction: text.default(""),
    projectUrl: z.union([safeUrl, z.literal("")]).default(""),
  })
  .strict();
export type EditableIdea = z.infer<typeof editableIdeaSchema>;
export const uuid = z
  .string()
  .uuid()
  .transform((v) => v.toLowerCase());
export const filtersSchema = z
  .object({
    query: z.string().trim().max(300).optional(),
    category: z.enum(categories).optional(),
    status: z.enum(statuses).optional(),
    source: z.enum(systems).optional(),
    effort: z.enum(efforts).optional(),
    minScore: z.coerce.number().min(0).max(100).optional(),
    sort: z.enum(["score", "recent", "title"]).default("score"),
  })
  .strict();
export type IdeaFilter = z.infer<typeof filtersSchema>;
const rating = z.number().int().min(1).max(5).nullable();
export const scoresSchema = z.object({
  impact: rating,
  alignment: rating,
  feasibility: rating,
  reusability: rating,
  timing: rating,
});
export type Scores = z.infer<typeof scoresSchema>;
export const weights = {
  impact: 0.3,
  alignment: 0.25,
  feasibility: 0.2,
  reusability: 0.15,
  timing: 0.1,
};
export function scoreFromRatings(scores: Scores): number | null {
  if (Object.values(scores).some((v) => v === null)) return null;
  return Math.round(
    Object.entries(scores).reduce(
      (sum, [key, v]) => sum + ((v ?? 1) - 1) * weights[key as keyof Scores],
      0,
    ) * 25,
  );
}
export interface Source {
  id: string;
  system: string;
  identifier: string;
  url: string | null;
  conversationDate: string | null;
  capturedDate: string | null;
  summary: string;
  ideaIds: string[];
}
export interface Evaluation {
  originalIdeaIds?: string[];
  id: string;
  date: string | null;
  overallScore: number | null;
  scores: Scores;
  rationale: string;
  risks: string;
  assumptions: string;
  benefits: string;
  effort: string | null;
  readiness: string | null;
  confidence: number | null;
  nextAction: string;
  model: string;
  rubricVersion: string;
  authority: string | null;
  url: string | null;
}
export interface Idea extends EditableIdea {
  roundtableScore?: import("../roundtable/score").RoundtableScore;
  id: string;
  url: string | null;
  createdAt: string;
  updatedAt: string;
  lastReviewed: string | null;
  revision: string;
  priorityScore: number | null;
  scores: Scores;
  confidence: number | null;
  scoreAuthority: string | null;
  sourceIds: string[];
  sources: Source[];
  latestEvaluationId: string | null;
  relatedIdeaIds: string[];
  canonicalIdeaId: string | null;
}
export interface Review {
  workflow?: "extraction" | "assessment";
  id: string;
  title: string;
  type: string | null;
  status: string | null;
  candidateIdeaId: string | null;
  matchingIdeaId: string | null;
  similarity: number | null;
  recommendation: string | null;
  reasoning: string;
  url: string | null;
}
export interface IdeaDetail {
  mergedIdeas?: Idea[];
  sources?: Source[];
  idea: Idea;
  evaluations: Evaluation[];
  relatedIdeas: Pick<Idea, "id" | "title" | "url">[];
  relatedTotal: number;
  reviews: Review[];
}
export const commandSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("create"),
      data: editableIdeaSchema,
      source: importSourceSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("update"),
      id: uuid,
      expectedRevision: z.string().min(1).max(300),
      data: editableIdeaSchema,
    })
    .strict(),
]);
export type IdeaCommand = z.infer<typeof commandSchema>;
export function editable(idea: Idea): EditableIdea {
  return Object.fromEntries(
    Object.keys(editableIdeaSchema.shape).map((k) => [
      k,
      idea[k as keyof Idea],
    ]),
  ) as EditableIdea;
}
export function filterIdeas(ideas: Idea[], filter: IdeaFilter): Idea[] {
  const query = filter.query?.toLocaleLowerCase() ?? "";
  return ideas
    .filter(
      (i) =>
        (!query ||
          [i.title, i.summary, i.problem, i.solution, i.context]
            .join(" ")
            .toLocaleLowerCase()
            .includes(query)) &&
        (!filter.category || i.category === filter.category) &&
        (!filter.status || i.status === filter.status) &&
        (!filter.source || i.sources.some((s) => s.system === filter.source)) &&
        (!filter.effort || i.effort === filter.effort) &&
        (filter.minScore === undefined ||
          (i.priorityScore !== null && i.priorityScore >= filter.minScore)),
    )
    .sort((a, b) =>
      filter.sort === "recent"
        ? b.createdAt.localeCompare(a.createdAt)
        : filter.sort === "title"
          ? a.title.localeCompare(b.title)
          : (b.priorityScore ?? -1) - (a.priorityScore ?? -1) ||
            a.title.localeCompare(b.title),
    );
}
export const fieldLabels: Record<keyof EditableIdea, string> = {
  title: "Title",
  summary: "Summary",
  problem: "Problem statement",
  solution: "Proposed solution",
  audience: "Intended audience",
  expectedValue: "Expected value",
  context: "Relevant context",
  category: "Category",
  status: "Status",
  effort: "Estimated effort",
  readiness: "Readiness",
  nextAction: "Next action",
  projectUrl: "Project URL",
};
export function changes(before: EditableIdea | null, after: EditableIdea) {
  return (Object.keys(fieldLabels) as (keyof EditableIdea)[])
    .filter((k) => before?.[k] !== after[k])
    .map((k) => ({
      field: fieldLabels[k],
      before: before?.[k] ?? "",
      after: after[k],
    }));
}
