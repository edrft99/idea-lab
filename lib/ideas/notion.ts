import type { AIExtractionResult } from "../intelligence/extraction-model";
import { lineageIds, canonicalLineage } from "./lineage";
import {
  type ImportSource,
  sourceKey,
  sourceRevision,
} from "../imports/provenance";
import { z } from "zod";
import { AppError } from "./errors";
import type { NotionConfig } from "./runtime";
import {
  uuid,
  categories,
  statuses,
  efforts,
  readinessOptions,
  scoresSchema,
  editableIdeaSchema,
  filterIdeas,
  type Idea,
  type Source,
  type Evaluation,
  type Review,
  type IdeaDetail,
  type IdeaFilter,
  type EditableIdea,
} from "./domain";
const pageSchema = z.object({
  object: z.literal("page"),
  id: uuid,
  url: z.string().url().optional(),
  parent: z.object({
    data_source_id: z.string().optional(),
    database_id: z.string().optional(),
    type: z.string(),
  }),
  properties: z.record(z.any()),
  created_time: z.string(),
  last_edited_time: z.string(),
  in_trash: z.boolean().optional(),
});
type Page = z.infer<typeof pageSchema>;
type Schema = Record<string, { id: string; type: string }>;
const ideaTypes: Record<string, string> = {
  Title: "title",
  Summary: "rich_text",
  "Problem Statement": "rich_text",
  "Proposed Solution": "rich_text",
  Category: "select",
  Status: "select",
  "Priority Score": "number",
  Impact: "number",
  "Strategic Alignment": "number",
  Feasibility: "number",
  Reusability: "number",
  Timing: "number",
  "Estimated Effort": "select",
  "Evaluation Confidence": "number",
  "Next Action": "rich_text",
  "Date Created": "created_time",
  "Last Updated": "last_edited_time",
  "Last Reviewed": "date",
  Sources: "relation",
  "Latest Evaluation": "relation",
  "Related Ideas": "relation",
  "Canonical Idea": "relation",
  "Project URL": "url",
  "Intended Audience": "rich_text",
  "Expected Value": "rich_text",
  "Relevant Context": "rich_text",
  Readiness: "select",
  "Score Authority": "select",
  "Approved By": "rich_text",
  "Approved At": "date",
  "Record Version": "rich_text",
  "Schema Version": "number",
};
const plain = (p: any): string =>
  (p?.title ?? p?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
const selection = (p: any): string | null =>
  p?.select?.name ?? p?.status?.name ?? null;
const number = (p: any): number | null => p?.number ?? null;
const date = (p: any): string | null => p?.date?.start ?? null;
const relations = (p: any): string[] =>
  (p?.relation ?? []).map((r: any) => r.id);
const safeURL = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    return ["http:", "https:"].includes(u.protocol) ? value : null;
  } catch {
    return null;
  }
};
export function richText(content: string) {
  const chunks = [];
  const chars = Array.from(content);
  for (let n = 0; n < chars.length; n += 950)
    chunks.push({
      type: "text",
      text: { content: chars.slice(n, n + 950).join("") },
    });
  return { rich_text: chunks };
}
function property(page: Page, name: string) {
  return page.properties[name];
}
export function decodeSource(page: Page): Source {
  return {
    id: page.id,
    system: selection(property(page, "Source System")) ?? "Unknown",
    identifier: plain(property(page, "Source Identifier")),
    url: safeURL(property(page, "Original URL")?.url),
    conversationDate: date(property(page, "Conversation Date")),
    capturedDate: date(property(page, "Captured Date")),
    summary: plain(property(page, "Extracted Summary")),
    ideaIds: relations(property(page, "Related Idea")),
  };
}
export function decodeIdea(page: Page, sources: Source[] = []): Idea {
  const p = (name: string) => property(page, name);
  const values = editableIdeaSchema.safeParse({
    title: plain(p("Title")),
    summary: plain(p("Summary")) || " ",
    problem: plain(p("Problem Statement")),
    solution: plain(p("Proposed Solution")),
    audience: plain(p("Intended Audience")),
    expectedValue: plain(p("Expected Value")),
    context: plain(p("Relevant Context")),
    category: selection(p("Category")),
    status: selection(p("Status")),
    effort: selection(p("Estimated Effort")) ?? "Unknown",
    readiness: selection(p("Readiness")) ?? "Discovery",
    nextAction: plain(p("Next Action")),
    projectUrl: safeURL(p("Project URL")?.url) ?? "",
  });
  // Existing records may be partially described; this is not a default for new writes.
  if (!values.success) {
    const relaxed = {
      title: plain(p("Title")),
      summary: plain(p("Summary")),
      problem: plain(p("Problem Statement")),
      solution: plain(p("Proposed Solution")),
      audience: plain(p("Intended Audience")),
      expectedValue: plain(p("Expected Value")),
      context: plain(p("Relevant Context")),
      category: selection(p("Category")),
      status: selection(p("Status")),
      effort: selection(p("Estimated Effort")) ?? "Unknown",
      readiness: selection(p("Readiness")) ?? "Discovery",
      nextAction: plain(p("Next Action")),
      projectUrl: safeURL(p("Project URL")?.url) ?? "",
    };
    if (
      !categories.includes(relaxed.category as any) ||
      !statuses.includes(relaxed.status as any) ||
      !efforts.includes(relaxed.effort as any) ||
      !readinessOptions.includes(relaxed.readiness as any)
    )
      throw new AppError(
        "NOTION_RECORD_INVALID",
        "A Notion idea has unsupported category, status or effort values.",
      );
    return finishIdea(page, relaxed as EditableIdea, sources);
  }
  return finishIdea(
    page,
    { ...values.data, summary: plain(p("Summary")) },
    sources,
  );
}
function finishIdea(page: Page, data: EditableIdea, sources: Source[]): Idea {
  if (relations(page.properties["Canonical Idea"]).length > 1)
    throw new AppError(
      "CANONICAL_LINEAGE_INVALID",
      "An idea has multiple canonical survivors. Inspect it in Notion.",
      503,
    );
  const p = (n: string) => property(page, n),
    priorityScore = number(p("Priority Score")),
    confidence = number(p("Evaluation Confidence"));
  if (
    (priorityScore !== null && (priorityScore < 0 || priorityScore > 100)) ||
    (confidence !== null && (confidence < 0 || confidence > 1))
  )
    throw new AppError(
      "NOTION_RECORD_INVALID",
      "A Notion score or confidence is outside the supported range.",
    );
  return {
    ...data,
    id: page.id,
    url: safeURL(page.url),
    createdAt: page.created_time,
    updatedAt: page.last_edited_time,
    lastReviewed: date(p("Last Reviewed")),
    revision: plain(p("Record Version")) + "@" + page.last_edited_time,
    priorityScore,
    confidence,
    scores: scoresSchema.parse({
      impact: number(p("Impact")),
      alignment: number(p("Strategic Alignment")),
      feasibility: number(p("Feasibility")),
      reusability: number(p("Reusability")),
      timing: number(p("Timing")),
    }),
    scoreAuthority: selection(p("Score Authority")),
    sourceIds: relations(p("Sources")),
    sources,
    latestEvaluationId: relations(p("Latest Evaluation"))[0] ?? null,
    relatedIdeaIds: relations(p("Related Ideas")),
    canonicalIdeaId: relations(p("Canonical Idea"))[0] ?? null,
  };
}
export function decodeEvaluation(page: Page): Evaluation {
  const p = (n: string) => property(page, n);
  return {
    id: page.id,
    date: date(p("Evaluation Date")),
    overallScore: number(p("Overall Score")),
    scores: scoresSchema.parse({
      impact: number(p("Impact Score")),
      alignment: number(p("Alignment Score")),
      feasibility: number(p("Feasibility Score")),
      reusability: number(p("Reusability Score")),
      timing: number(p("Timing Score")),
    }),
    rationale: plain(p("Rationale")),
    risks: plain(p("Risks")),
    assumptions: plain(p("Assumptions")),
    benefits: plain(p("Potential Benefits")),
    effort: selection(p("Estimated Effort")),
    readiness: selection(p("Readiness")),
    confidence: number(p("Confidence")),
    nextAction: plain(p("Recommended Next Action")),
    model: plain(p("Model Identifier")),
    rubricVersion: plain(p("Rubric Version")),
    authority: selection(p("Authority")),
    url: safeURL(page.url),
  };
}
export function decodeReview(page: Page): Review {
  const p = (n: string) => property(page, n);
  return {
    id: page.id,
    title: plain(p("Name")),
    workflow:
      plain(p("Classification Version")) === "extraction-proposal-v1"
        ? "extraction"
        : plain(p("Classification Version")) === "assessment-proposal-v1"
          ? "assessment"
          : undefined,
    type: selection(p("Review Type")),
    status: selection(p("Status")),
    candidateIdeaId: relations(p("Candidate Idea"))[0] ?? null,
    matchingIdeaId: relations(p("Potential Matching Idea"))[0] ?? null,
    similarity: number(p("Similarity Score")),
    recommendation: selection(p("AI Recommendation")),
    reasoning: plain(p("Reasoning")),
    url: safeURL(page.url),
  };
}
export class NotionRepository {
  constructor(
    readonly config: NotionConfig,
    private request: typeof fetch = fetch,
  ) {}
  async call(path: string, method = "GET", body?: unknown): Promise<any> {
    const write = method === "PATCH" || path === "pages";
    let response: Response;
    try {
      response = await this.request("https://api.notion.com/v1/" + path, {
        method,
        headers: {
          Authorization: "Bearer " + this.config.token,
          "Notion-Version": this.config.version,
          "Content-Type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        cache: "no-store",
        signal: AbortSignal.timeout(15000),
        redirect: "manual",
      });
    } catch (error) {
      const e = error as {
        name?: string;
        message?: string;
        cause?: { code?: string };
      };
      const allowed = new Set([
        "EACCES",
        "ENOTFOUND",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ECONNRESET",
        "CERT_HAS_EXPIRED",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ]);
      const category = /redirect/i.test(e?.message ?? "")
        ? "REDIRECT_MODE_ERROR"
        : /cache/i.test(e?.message ?? "")
          ? "CACHE_MODE_ERROR"
          : /signal|abort/i.test(e?.message ?? "")
            ? "SIGNAL_ERROR"
            : /illegal invocation/i.test(e?.message ?? "")
              ? "ILLEGAL_INVOCATION"
              : /invalid.*header|bytestring/i.test(e?.message ?? "")
                ? "INVALID_HEADERS"
                : allowed.has(e?.cause?.code ?? "")
                  ? e.cause!.code
                  : "FETCH_FAILED";
      console.error(
        JSON.stringify({
          event: "notion_transport_failed",
          category,
          type: ["TypeError", "AbortError", "TimeoutError", "Error"].includes(
            e?.name ?? "",
          )
            ? e.name
            : "UnknownError",
        }),
      );
      throw new AppError(
        write ? "WRITE_UNCERTAIN" : "NOTION_UNAVAILABLE",
        write
          ? "Notion did not confirm the save. Check its operation status before trying another save."
          : "Notion could not be reached.",
        503,
        undefined,
        write,
      );
    }
    if (response.status >= 300 && response.status < 400)
      throw new AppError(
        write ? "WRITE_UNCERTAIN" : "NOTION_REDIRECT_REFUSED",
        write
          ? "Notion returned a redirect without confirming the save. Check its status before another save."
          : "Notion returned an unexpected redirect. The request was not followed.",
        502,
        undefined,
        write,
      );
    if (!response.ok) {
      const raw = response.headers.get("Retry-After"),
        retry = raw && /^\d+$/.test(raw) ? Number(raw) : undefined;
      if (response.status === 401)
        throw new AppError(
          "NOTION_CREDENTIAL_REJECTED",
          "The Notion connection token was rejected.",
        );
      if (response.status === 403)
        throw new AppError(
          "NOTION_ACCESS_DENIED",
          "Grant the Idea Lab connection access to the workspace databases and required content capabilities.",
          403,
        );
      if (response.status === 404)
        throw new AppError(
          "NOT_FOUND",
          "The Notion record or data source is unavailable.",
          404,
        );
      if (write && response.status >= 500)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "Notion did not confirm the save. Reconcile this operation before another save.",
          503,
          retry,
          true,
        );
      if (response.status === 429 || response.status === 529)
        throw new AppError(
          "NOTION_RATE_LIMITED",
          "Notion is busy. Wait before retrying.",
          503,
          retry,
        );
      throw new AppError(
        "NOTION_REQUEST_FAILED",
        "Notion rejected this request. No automatic retry was made.",
        502,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new AppError(
        write ? "WRITE_UNCERTAIN" : "NOTION_RESPONSE_INVALID",
        "Notion returned an unreadable response.",
        503,
        undefined,
        write,
      );
    }
  }
  async schema(
    id: string,
    required: Record<string, string> = {},
  ): Promise<Schema> {
    const raw = await this.call("data_sources/" + id),
      schema = z
        .record(z.object({ id: z.string(), type: z.string() }))
        .parse(raw.properties);
    for (const [name, type] of Object.entries(required))
      if (schema[name]?.type !== type)
        throw new AppError(
          "NOTION_SCHEMA_MISMATCH",
          "The Notion data-source schema differs from the configured Idea Lab model.",
        );
    return schema;
  }
  private async relationPages(page: Page): Promise<Page> {
    for (const [name, p] of Object.entries(page.properties)) {
      if (p?.type !== "relation" || !p.has_more) continue;
      let cursor: string | undefined;
      const ids: string[] = [];
      const seen = new Set<string>();
      do {
        const result = await this.call(
          "pages/" +
            page.id +
            "/properties/" +
            encodeURIComponent(p.id) +
            (cursor ? "?start_cursor=" + encodeURIComponent(cursor) : ""),
        );
        for (const item of result.results ?? [])
          if (item.relation?.id) ids.push(item.relation.id);
        cursor = this.next(result, cursor, seen);
        if (ids.length > 10000)
          throw new AppError(
            "RESULT_LIMIT",
            "This relation is too large to load safely.",
          );
      } while (cursor);
      page.properties[name] = {
        ...p,
        relation: ids.map((id) => ({ id })),
        has_more: false,
      };
    }
    return page;
  }
  private next(
    raw: any,
    current: string | undefined,
    seen: Set<string>,
  ): string | undefined {
    if (!raw.has_more) return undefined;
    if (
      typeof raw.next_cursor !== "string" ||
      !raw.next_cursor ||
      raw.next_cursor === current ||
      seen.has(raw.next_cursor)
    )
      throw new AppError(
        "NOTION_PAGINATION_INVALID",
        "Notion returned invalid pagination.",
      );
    seen.add(raw.next_cursor);
    return raw.next_cursor;
  }
  async query(id: string, filter?: unknown): Promise<Page[]> {
    const all: Page[] = [];
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const result = await this.call("data_sources/" + id + "/query", "POST", {
        page_size: 100,
        ...(filter ? { filter } : {}),
        ...(cursor ? { start_cursor: cursor } : {}),
      });
      if (!Array.isArray(result.results))
        throw new AppError(
          "NOTION_RESPONSE_INVALID",
          "Notion returned invalid records.",
        );
      for (const raw of result.results) {
        const page = this.checked(raw, id);
        if (!page.in_trash) all.push(await this.relationPages(page));
      }
      cursor = this.next(result, cursor, seen);
      if (all.length > 10000)
        throw new AppError(
          "RESULT_LIMIT",
          "This collection is too large for the current bounded read.",
        );
    } while (cursor);
    return all;
  }
  protected checked(raw: unknown, source: string): Page {
    const p = pageSchema.parse(raw);
    if (p.parent.data_source_id !== source)
      throw new AppError(
        "NOT_FOUND",
        "This record is outside the configured collection.",
        404,
      );
    return p;
  }
  async page(id: string, source = this.config.ideas): Promise<Page> {
    const page = this.checked(await this.call("pages/" + id), source);
    if (page.id !== id.toLowerCase())
      throw new AppError(
        "NOTION_RESPONSE_INVALID",
        "Notion returned a different record than requested.",
        502,
      );
    return this.relationPages(page);
  }
  async list(filter: IdeaFilter): Promise<Idea[]> {
    await this.schema(this.config.ideas, ideaTypes);
    await this.schema(this.config.sources, {
      "Related Idea": "relation",
      "Source System": "select",
    });
    const ideas = await this.query(this.config.ideas),
      sources = (await this.query(this.config.sources)).map(decodeSource);
    const records = ideas.map((p) =>
      decodeIdea(
        p,
        sources.filter(
          (s) =>
            s.ideaIds.includes(p.id) ||
            relations(p.properties.Sources).includes(s.id),
        ),
      ),
    );
    const lineage = canonicalLineage(records);
    const enriched = records
      .filter((i) => !i.canonicalIdeaId || filter.status === "Archived")
      .map((i) => {
        const members = new Set(lineage(i.id));
        const referencedSources = new Set(
          records.filter((r) => members.has(r.id)).flatMap((r) => r.sourceIds),
        );
        return {
          ...i,
          sources: sources.filter(
            (s) =>
              s.ideaIds.some((id) => members.has(id)) ||
              referencedSources.has(s.id),
          ),
        };
      });
    return filterIdeas(enriched, filter);
  }

  async listSemanticIdeas(): Promise<Idea[]> {
    await this.schema(this.config.ideas, ideaTypes);
    return (await this.query(this.config.ideas))
      .map((p) => decodeIdea(p))
      .filter((i) => !i.canonicalIdeaId);
  }
  async getSemanticIdea(id: string): Promise<Idea> {
    await this.schema(this.config.ideas, ideaTypes);
    const p = await this.page(id);
    if (p.in_trash)
      throw new AppError("NOT_FOUND", "This idea is in Notion trash.", 404);
    return decodeIdea(p);
  }
  async get(id: string): Promise<Idea> {
    await this.schema(this.config.ideas, ideaTypes);
    const p = await this.page(id);
    if (p.in_trash)
      throw new AppError("NOT_FOUND", "This idea is in Notion trash.", 404);
    const sources = (
      await this.query(this.config.sources, {
        property: "Related Idea",
        relation: { contains: id },
      })
    ).map(decodeSource);
    return decodeIdea(p, sources);
  }
  async reviews(): Promise<Review[]> {
    await this.schema(this.config.reviews, {
      Name: "title",
      "Candidate Idea": "relation",
      "Potential Matching Idea": "relation",
      Status: "select",
    });
    return (
      await this.query(this.config.reviews, {
        property: "Status",
        select: { equals: "Pending" },
      })
    ).map(decodeReview);
  }
  async detail(id: string): Promise<IdeaDetail> {
    const idea = await this.get(id);
    await this.schema(this.config.evaluations, {
      "Related Idea": "relation",
      "Evaluation Date": "date",
    });
    const pages = await this.query(this.config.ideas),
      records = pages.map((p) => decodeIdea(p)),
      familyIds = lineageIds(idea.id, records),
      familySet = new Set(familyIds),
      sourceRows = (await this.query(this.config.sources)).map(decodeSource);
    const mergedIdeas = familyIds.slice(1).map((member) => {
      const p = pages.find((p) => p.id === member)!;
      const directIds = relations(p.properties.Sources);
      return decodeIdea(
        p,
        sourceRows.filter(
          (s) => s.ideaIds.includes(member) || directIds.includes(s.id),
        ),
      );
    });
    const sourceIds = new Set(
      [idea, ...mergedIdeas].flatMap((i) => i.sourceIds),
    );
    const sources = sourceRows.filter(
      (s) => s.ideaIds.some((id) => familySet.has(id)) || sourceIds.has(s.id),
    );
    const filter =
      familyIds.length === 1
        ? { property: "Related Idea", relation: { contains: idea.id } }
        : {
            or: familyIds.map((member) => ({
              property: "Related Idea",
              relation: { contains: member },
            })),
          };
    const evaluations = (await this.query(this.config.evaluations, filter))
      .map((p) => ({
        ...decodeEvaluation(p),
        originalIdeaIds: relations(p.properties["Related Idea"]),
      }))
      .sort(
        (a, b) =>
          (b.date ?? "").localeCompare(a.date ?? "") ||
          a.id.localeCompare(b.id),
      );
    const relatedIds = [
      ...new Set([idea, ...mergedIdeas].flatMap((i) => i.relatedIdeaIds)),
    ].filter((other) => !familySet.has(other));
    const relatedIdeas = [];
    for (const other of relatedIds.slice(0, 20)) {
      try {
        const p = await this.page(other);
        if (!p.in_trash)
          relatedIdeas.push({
            id: p.id,
            title: plain(p.properties.Title),
            url: safeURL(p.url),
          });
      } catch (e) {
        if (!(e instanceof AppError && e.status === 404)) throw e;
      }
    }
    return {
      idea,
      evaluations,
      mergedIdeas,
      sources,
      relatedIdeas,
      relatedTotal: relatedIds.length,
      reviews: (await this.reviews()).filter(
        (r) =>
          (r.candidateIdeaId && familySet.has(r.candidateIdeaId)) ||
          (r.matchingIdeaId && familySet.has(r.matchingIdeaId)),
      ),
    };
  }
  async findOperation(operation: string): Promise<Idea | null> {
    const rows = await this.query(this.config.ideas, {
      property: "Record Version",
      rich_text: { contains: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple records reference this operation. Review them in Notion.",
      );
    return rows[0] ? decodeIdea(rows[0]) : null;
  }
  async write(
    data: EditableIdea,
    operation: string,
    actor: string,
    id?: string,
    expectedRevision?: string,
    beforeWrite?: () => Promise<void>,
  ): Promise<Idea> {
    const schema = await this.schema(this.config.ideas, ideaTypes);
    const props: Record<string, unknown> = {};
    const rich: Record<string, string> = {
      summary: "Summary",
      problem: "Problem Statement",
      solution: "Proposed Solution",
      audience: "Intended Audience",
      expectedValue: "Expected Value",
      context: "Relevant Context",
      nextAction: "Next Action",
    };
    props[schema.Title.id] = {
      title: [{ type: "text", text: { content: data.title } }],
    };
    for (const [key, name] of Object.entries(rich))
      props[schema[name].id] = richText(data[key as keyof EditableIdea]);
    for (const [key, name] of Object.entries({
      category: "Category",
      status: "Status",
      effort: "Estimated Effort",
      readiness: "Readiness",
    }))
      props[schema[name].id] = {
        select: { name: data[key as keyof EditableIdea] },
      };
    props[schema["Project URL"].id] = { url: data.projectUrl || null };
    let marker = "created:" + operation;
    if (id) {
      const before = await this.page(id);
      if (expectedRevision && decodeIdea(before).revision !== expectedRevision)
        throw new AppError(
          "STALE_IDEA",
          "This idea changed before saving. Reload and review it again.",
          409,
        );
      marker =
        plain(before.properties["Record Version"]).split(";")[0] ||
        "legacy:" + id;
    }
    props[schema["Record Version"].id] = richText(
      marker + ";revision:" + operation,
    );
    props[schema["Schema Version"].id] = { number: 1 };
    props[schema["Approved By"].id] = richText(actor);
    props[schema["Approved At"].id] = {
      date: { start: new Date().toISOString() },
    };
    await beforeWrite?.();
    const raw = await this.call(
      id ? "pages/" + id : "pages",
      id ? "PATCH" : "POST",
      {
        ...(id
          ? {}
          : {
              parent: {
                type: "data_source_id",
                data_source_id: this.config.ideas,
              },
            }),
        properties: props,
      },
    );
    try {
      return decodeIdea(this.checked(raw, this.config.ideas));
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "Notion saved a record but its returned state could not be verified. Reconcile the operation.",
        503,
        undefined,
        true,
      );
    }
  }

  async manualSource(
    idea: Idea,
    operation: string,
    contentHash: string,
  ): Promise<Source> {
    const schema = await this.schema(this.config.sources, {
      Name: "title",
      "Related Idea": "relation",
      "Source Key": "rich_text",
      "Operation ID": "rich_text",
    });
    const existing = await this.query(this.config.sources, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (existing.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple provenance records reference this save.",
      );
    if (existing[0]) return decodeSource(existing[0]);
    const props: Record<string, unknown> = {};
    const set = (name: string, value: unknown) => {
      if (!schema[name])
        throw new AppError(
          "NOTION_SCHEMA_MISMATCH",
          "The source schema is missing a required property.",
        );
      props[schema[name].id] = value;
    };
    set("Name", {
      title: [
        { type: "text", text: { content: "Manual capture · " + idea.title } },
      ],
    });
    set("Source System", { select: { name: "Manual" } });
    set("Source Identifier", richText("manual:" + operation));
    set("Captured Date", { date: { start: new Date().toISOString() } });
    set("Extracted Summary", richText(idea.summary));
    set("Content Hash", richText(contentHash));
    set("Import Batch", richText("manual"));
    set("Related Idea", { relation: [{ id: idea.id }] });
    set("Source Key", richText("manual:" + operation));
    set("Adapter Version", richText("manual-v1"));
    set("Operation ID", richText(operation));
    set("Processing Status", { select: { name: "Complete" } });
    set("Source Revision", richText(contentHash));
    const raw = await this.call("pages", "POST", {
      parent: { type: "data_source_id", data_source_id: this.config.sources },
      properties: props,
    });
    return decodeSource(this.checked(raw, this.config.sources));
  }
  async hasManualSource(operation: string): Promise<boolean> {
    const matches = await this.query(this.config.sources, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (matches.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple provenance records reference this save.",
      );
    return matches.length === 1;
  }

  async extractionReviews(source: ImportSource): Promise<string[]> {
    const key = "extraction:" + (await sourceKey(source));
    return (
      await this.query(this.config.reviews, {
        and: [
          { property: "Pair Key", rich_text: { equals: key } },
          {
            property: "Classification Version",
            rich_text: { equals: "extraction-proposal-v1" },
          },
        ],
      })
    ).map((p) => p.id);
  }
  async importedSourceState(
    source: ImportSource,
  ): Promise<{ source: Source; revision: string; operation?: string } | null> {
    return this.importedSourceByKey(await sourceKey(source));
  }
  async importedSourceByKey(
    key: string,
  ): Promise<{ source: Source; revision: string; operation?: string } | null> {
    if (!/^import:[a-f0-9]{64}$/.test(key))
      throw new AppError(
        "INVALID_SOURCE",
        "This import source key is invalid.",
        400,
      );
    await this.schema(this.config.sources, {
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
    });
    const matches = await this.query(this.config.sources, {
      property: "Source Key",
      rich_text: { equals: key },
    });
    if (matches.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple canonical sources share this identity. Review them before another import.",
        409,
      );
    if (!matches[0]) return null;
    return {
      source: decodeSource(matches[0]),
      revision: plain(matches[0].properties["Source Revision"]),
      operation: plain(matches[0].properties["Operation ID"]),
    };
  }
  async importSource(
    idea: Idea,
    operation: string,
    source: ImportSource,
    aiExtraction?: AIExtractionResult,
    aiReview?: {
      proposalId: string;
      intentId: string;
      overrideReason: string | null;
    },
    beforeWrite?: () => Promise<void>,
  ): Promise<Source> {
    const schema = await this.schema(this.config.sources, {
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
    });
    const prior = await this.importedSourceState(source),
      revision = await sourceRevision(source);
    if (prior) {
      if (
        prior.revision !== revision ||
        !prior.source.ideaIds.includes(idea.id)
      )
        throw new AppError(
          "SOURCE_ALREADY_IMPORTED",
          "This source identity already belongs to a canonical record. Review it instead of creating another source.",
          409,
        );
      return prior.source;
    }
    const values: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content: (source.system + " · " + idea.title).slice(0, 200),
            },
          },
        ],
      },
      "Source System": { select: { name: source.system } },
      "Source Identifier": richText(
        source.conversationId + "/" + source.messageId,
      ),
      "Original URL": { url: source.originalUrl },
      "Conversation Date": {
        date: source.conversationDate
          ? { start: source.conversationDate }
          : null,
      },
      "Captured Date": { date: { start: new Date().toISOString() } },
      "Extracted Summary": richText(source.evidence),
      "Content Hash": richText(revision),
      "Import Batch": richText("selected:" + operation),
      "Related Idea": { relation: [{ id: idea.id }] },
      "Source Key": richText(await sourceKey(source)),
      "Source Revision": richText(revision),
      "Adapter Version": richText(source.adapterVersion),
      "Operation ID": richText(operation),
      "Processing Status": { select: { name: "Complete" } },
    };
    await beforeWrite?.();
    const raw = await this.call("pages", "POST", {
      parent: { type: "data_source_id", data_source_id: this.config.sources },
      children: [
        {
          object: "block",
          type: "code",
          code: {
            language: "json",
            ...richText(
              JSON.stringify(
                {
                  format: "idea-lab-selected-source",
                  version: aiExtraction ? 2 : 1,
                  source,
                  ...(aiExtraction
                    ? { aiExtraction, ...(aiReview ? { aiReview } : {}) }
                    : {}),
                },
                null,
                2,
              ),
            ),
          },
        },
      ],
      properties: Object.fromEntries(
        Object.entries(values).map(([key, value]) => [schema[key].id, value]),
      ),
    });
    return decodeSource(this.checked(raw, this.config.sources));
  }
}
