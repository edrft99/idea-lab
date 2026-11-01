import { vi } from "vitest";
import { config, ids, input, props, page, schema, memoryDB } from "./fixtures";
import { ProposalRepository } from "../lib/proposals/repository";
import { ProposalService } from "../lib/proposals/service";
import { Operations } from "../lib/ideas/operations";
import { importSourceSchema } from "../lib/imports/provenance";
export const source = importSourceSchema.parse({
  system: "ChatGPT",
  conversationId: "synthetic-proposal",
  messageId: "m1",
  locator: "ChatGPT:synthetic-proposal/message/m1",
  originalUrl: null,
  conversationDate: null,
  adapterVersion: "chatgpt-mapping-v1",
  role: "user",
  evidence: "Build a portable sensor demonstration.",
});
export const command = {
  data: input,
  source,
  note: "Review this selected suggestion.",
  reconsider: false,
  reconsiderReason: "",
};
const reviewTypes: Record<string, string> = {
  Name: "title",
  "Review Type": "select",
  "Candidate Idea": "relation",
  "Potential Matching Idea": "relation",
  "Similarity Score": "number",
  "AI Recommendation": "select",
  Reasoning: "rich_text",
  Status: "select",
  "Reviewer Decision": "rich_text",
  "Reviewed Date": "date",
  Reviewer: "rich_text",
  "Candidate Revision": "rich_text",
  "Match Revision": "rich_text",
  "Pair Key": "rich_text",
  "Proposal Payload": "rich_text",
  "Embedding Version": "rich_text",
  "Classification Version": "rich_text",
  "Approval Hash": "rich_text",
  "Operation ID": "rich_text",
};
const sourceTypes: Record<string, string> = {
  Name: "title",
  "Source System": "select",
  "Source Identifier": "rich_text",
  "Original URL": "url",
  "Conversation Date": "date",
  "Captured Date": "date",
  "Extracted Summary": "rich_text",
  "Content Hash": "rich_text",
  "Import Batch": "rich_text",
  "Related Idea": "relation",
  "Source Key": "rich_text",
  "Source Revision": "rich_text",
  "Adapter Version": "rich_text",
  "Operation ID": "rich_text",
  "Processing Status": "select",
};
const evaluationTypes: Record<string, string> = {
  Name: "title",
  "Related Idea": "relation",
  "Evaluation Date": "date",
  "Overall Score": "number",
  "Impact Score": "number",
  "Alignment Score": "number",
  "Feasibility Score": "number",
  "Reusability Score": "number",
  "Timing Score": "number",
  Rationale: "rich_text",
  Risks: "rich_text",
  Assumptions: "rich_text",
  "Recommended Next Action": "rich_text",
  "Model Identifier": "rich_text",
  "Rubric Version": "rich_text",
  "Potential Benefits": "rich_text",
  "Estimated Effort": "select",
  Readiness: "select",
  Confidence: "number",
  Authority: "select",
  "Approved By": "rich_text",
  "Approved At": "date",
  "Input Revision": "rich_text",
  "Weight Snapshot": "rich_text",
};
const properties = (types: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(types).map(([name, type], n) => [
      name,
      {
        id: "f" + n,
        type,
        [type]: ["rich_text", "title", "relation"].includes(type) ? [] : null,
      },
    ]),
  );
export const text = (p: any) =>
  (p?.rich_text ?? p?.title ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
function matches(row: any, filter: any): boolean {
  if (!filter) return true;
  if (filter.and) return filter.and.every((f: any) => matches(row, f));
  if (filter.or) return filter.or.some((f: any) => matches(row, f));
  const p = row.properties[filter.property];
  if (filter.rich_text)
    return filter.rich_text.equals !== undefined
      ? text(p) === filter.rich_text.equals
      : text(p).includes(filter.rich_text.contains);
  if (filter.title) return text(p).includes(filter.title.contains);
  if (filter.select) return p?.select?.name === filter.select.equals;
  if (filter.relation)
    return p?.relation?.some((r: any) => r.id === filter.relation.contains);
  throw new Error("Unsupported fixture filter");
}
export function setup() {
  const memory = memoryDB(),
    ops = new Operations(memory.db),
    rows = new Map<string, any>(),
    events: { method: string; path: string; body: any }[] = [];
  const definitions: Record<string, any> = {
    [ids.ideas]: props(),
    [ids.evaluations]: properties(evaluationTypes),
    [ids.sources]: properties(sourceTypes),
    [ids.reviews]: properties(reviewTypes),
  };
  let next = 100,
    tick = 0;
  const faults = {
    lostCreate: "",
    denyCreate: "",
    denyClose: false,
    denyProjection: false,
    lostProjection: false,
    lostClose: false,
    hideHistory: false,
  };
  const fetcher = vi.fn(async (url: any, options?: RequestInit) => {
    const target = String(url).replace("https://api.notion.com/v1/", ""),
      method = options?.method ?? "GET",
      body = options?.body ? JSON.parse(String(options.body)) : null;
    events.push({ method, path: target, body });
    const ds = target.match(/^data_sources\/([^/]+)(\/query)?$/);
    if (ds) {
      const definition = definitions[ds[1]];
      if (!definition) throw new Error("Unknown fixture data source");
      if (!ds[2]) return Response.json(schema(definition));
      const visible = [...rows.values()].filter(
        (r) =>
          r.parent.data_source_id === ds[1] &&
          matches(r, body.filter) &&
          !(faults.hideHistory && body.filter?.property === "Pair Key"),
      );
      return Response.json({
        results: visible,
        has_more: false,
        next_cursor: null,
      });
    }
    if (target === "pages" && method === "POST") {
      const parent = body.parent.data_source_id;
      if (faults.denyCreate === parent)
        return Response.json({ code: "restricted_resource" }, { status: 403 });
      const definition = definitions[parent],
        named = structuredClone(definition);
      for (const [key, value] of Object.entries(body.properties)) {
        const name = Object.keys(definition).find(
          (n) => definition[n].id === key,
        );
        if (!name) throw new Error("Unknown property");
        named[name] = { ...named[name], ...(value as object) };
      }
      const id =
        parent === ids.ideas
          ? ids.idea
          : parent === ids.sources
            ? ids.source
            : "70000000-0000-4000-8000-" + String(next++).padStart(12, "0");
      const row = page({
        id,
        parent: { type: "data_source_id", data_source_id: parent },
        properties: named,
        children: body.children ?? [],
        last_edited_time: new Date(
          Date.UTC(2026, 9, 31, 10, 0, tick++),
        ).toISOString(),
      });
      rows.set(id, row);
      if (faults.lostCreate === parent) {
        faults.lostCreate = "";
        throw new Error("Synthetic lost reply");
      }
      return Response.json(row);
    }
    if (target.startsWith("pages/")) {
      const row = rows.get(target.slice(6));
      if (!row)
        return Response.json({ code: "object_not_found" }, { status: 404 });
      if (method === "PATCH") {
        if (
          (faults.denyClose && row.parent.data_source_id === ids.reviews) ||
          (faults.denyProjection && row.parent.data_source_id === ids.ideas)
        )
          return Response.json(
            { code: "restricted_resource" },
            { status: 403 },
          );
        const definition = definitions[row.parent.data_source_id];
        for (const [key, value] of Object.entries(body.properties)) {
          const name = Object.keys(definition).find(
            (n) => definition[n].id === key,
          )!;
          row.properties[name] = {
            ...row.properties[name],
            ...(value as object),
          };
        }
        row.last_edited_time = new Date(
          Date.UTC(2026, 9, 31, 10, 0, tick++),
        ).toISOString();
        if (faults.lostProjection && row.parent.data_source_id === ids.ideas) {
          faults.lostProjection = false;
          throw new Error("Synthetic lost projection reply");
        }
        if (faults.lostClose && row.parent.data_source_id === ids.reviews) {
          faults.lostClose = false;
          throw new Error("Synthetic lost close reply");
        }
      }
      return Response.json(row);
    }
    throw new Error("Unexpected fixture request " + target);
  });
  const repo = new ProposalRepository(config, fetcher),
    service = new ProposalService(repo, ops);
  const writes = (parent?: string) =>
    events.filter(
      (e) =>
        ["POST", "PATCH"].includes(e.method) &&
        e.path.startsWith("pages") &&
        (!parent || e.body?.parent?.data_source_id === parent),
    );
  async function queued() {
    const receipt = await service.prepareStore(command, "owner");
    const saved = await service.store(command, receipt.approvalToken, "owner");
    return repo.proposal(saved.reviewId!);
  }
  return {
    memory,
    ops,
    repo,
    service,
    rows,
    events,
    faults,
    fetcher,
    writes,
    queued,
  };
}
