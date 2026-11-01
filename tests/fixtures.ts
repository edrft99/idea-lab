import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import type { OperationalDB, Statement } from "../lib/ideas/runtime";
import { editableIdeaSchema, type Idea } from "../lib/ideas/domain";
export const ids = {
  ideas: "10000000-0000-4000-8000-000000000001",
  sources: "20000000-0000-4000-8000-000000000002",
  evaluations: "30000000-0000-4000-8000-000000000003",
  reviews: "40000000-0000-4000-8000-000000000004",
  idea: "50000000-0000-4000-8000-000000000005",
  source: "60000000-0000-4000-8000-000000000006",
};
export const config = {
  token: "test-secret-not-real",
  version: "2026-03-11",
  ...ids,
};
export const input = editableIdeaSchema.parse({
  title: "Synthetic sensor kit",
  summary: "A portable sensor demo for testing.",
  category: "Hardware & IoT",
});
export const idea: Idea = {
  ...input,
  id: ids.idea,
  url: "https://app.notion.com/p/" + ids.idea,
  createdAt: "2026-10-30T10:00:00.000Z",
  updatedAt: "2026-10-30T10:00:00.000Z",
  lastReviewed: null,
  revision: "created:seed;revision:seed@2026-10-30T10:00:00.000Z",
  priorityScore: null,
  scores: {
    impact: null,
    alignment: null,
    feasibility: null,
    reusability: null,
    timing: null,
  },
  confidence: null,
  scoreAuthority: null,
  sourceIds: [],
  sources: [],
  latestEvaluationId: null,
  relatedIdeaIds: [],
  canonicalIdeaId: null,
};
export function props() {
  const rich = (value = "") => ({
    id: "",
    type: "rich_text",
    rich_text: value ? [{ plain_text: value }] : [],
  });
  const p: Record<string, any> = {
    Title: { id: "", type: "title", title: [{ plain_text: input.title }] },
    Summary: rich(input.summary),
    Category: { type: "select", select: { name: "Hardware & IoT" } },
    Status: { type: "select", select: { name: "Inbox" } },
  };
  for (const n of [
    "Problem Statement",
    "Proposed Solution",
    "Intended Audience",
    "Expected Value",
    "Relevant Context",
    "Next Action",
    "Approved By",
  ])
    p[n] = rich();
  p["Record Version"] = rich("created:seed;revision:seed");
  for (const n of [
    "Priority Score",
    "Impact",
    "Strategic Alignment",
    "Feasibility",
    "Reusability",
    "Timing",
    "Evaluation Confidence",
    "Schema Version",
  ])
    p[n] = { type: "number", number: null };
  for (const n of [
    "Sources",
    "Latest Evaluation",
    "Evaluation History",
    "Related Ideas",
    "Canonical Idea",
  ])
    p[n] = { type: "relation", relation: [], has_more: false };
  for (const n of ["Last Reviewed", "Approved At"])
    p[n] = { type: "date", date: null };
  p["Date Created"] = { type: "created_time", created_time: idea.createdAt };
  p["Last Updated"] = {
    type: "last_edited_time",
    last_edited_time: idea.updatedAt,
  };
  p["Project URL"] = { type: "url", url: null };
  p["Estimated Effort"] = { type: "select", select: { name: "Unknown" } };
  p.Readiness = { type: "select", select: { name: "Discovery" } };
  p["Score Authority"] = { type: "select", select: null };
  Object.values(p).forEach((v, n) => (v.id = "p" + n));
  return p;
}
export function page(overrides: Record<string, unknown> = {}) {
  return {
    object: "page",
    id: ids.idea,
    url: idea.url,
    parent: { type: "data_source_id", data_source_id: ids.ideas },
    created_time: idea.createdAt,
    last_edited_time: idea.updatedAt,
    properties: props(),
    in_trash: false,
    ...overrides,
  };
}
export function schema(p = props()) {
  return {
    properties: Object.fromEntries(
      Object.entries(p).map(([k, v]) => [k, { id: v.id, type: v.type }]),
    ),
  };
}
export function memoryDB() {
  const sqlite = new DatabaseSync(":memory:");
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url))
    .filter((f) => f.endsWith(".sql"))
    .sort())
    sqlite.exec(
      readFileSync(new URL("../drizzle/" + file, import.meta.url), "utf8"),
    );
  const commands = new WeakMap<Statement, () => unknown>();
  const db: OperationalDB = {
    async batch(statements) {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => {
          const execute = commands.get(statement);
          if (!execute) throw new Error("Foreign statement");
          return execute();
        });
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    prepare(sql) {
      let values: (string | number | null)[] = [];
      const stmt = {
        bind(...next: (string | number | null)[]) {
          values = next;
          return stmt;
        },
        async first<T>() {
          return (sqlite.prepare(sql).get(...values) as T) ?? null;
        },
        async all<T>() {
          return { results: sqlite.prepare(sql).all(...values) as T[] };
        },
        async run() {
          return sqlite.prepare(sql).run(...values);
        },
      };
      commands.set(stmt, () => sqlite.prepare(sql).run(...values));
      return stmt;
    },
  };
  return { db, close: () => sqlite.close() };
}
