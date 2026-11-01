import { z } from "zod";
import { type NotionConfig, envValue } from "../ideas/runtime";
import { AppError } from "../ideas/errors";
import { uuid } from "../ideas/domain";
import { type ParsedImport, type Conversation, type Turn } from "./model";
import { type ImportSource } from "./provenance";
import { redact } from "./staging";
import { notionReference, type NotionRows } from "./notion-model";
interface Transport {
  config: NotionConfig;
  call(path: string, method?: string, body?: unknown): Promise<any>;
}
const metaSchema = z
  .object({
    object: z.enum(["page", "block", "data_source", "database"]),
    id: uuid,
    parent: z.object({ type: z.string() }).passthrough(),
    archived: z.boolean().optional(),
    in_trash: z.boolean().optional(),
    created_time: z.string().optional(),
    last_edited_time: z.string().optional(),
  })
  .passthrough();
type Meta = z.infer<typeof metaSchema>;
const dateSchema = z.string().datetime({ offset: true });
const textTypes = new Set([
  "paragraph",
  "heading_1",
  "heading_2",
  "heading_3",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "quote",
  "callout",
  "code",
]);
const containers = new Set(["column_list", "column", "table"]);
const excluded = new Set([
  "child_page",
  "child_database",
  "synced_block",
  "link_to_page",
  "file",
  "pdf",
  "image",
  "video",
  "audio",
  "embed",
  "bookmark",
  "link_preview",
]);
const plain = (parts: any): string => {
  if (!Array.isArray(parts))
    throw new AppError(
      "NOTION_IMPORT_INVALID",
      "Notion returned an invalid text field.",
      502,
    );
  return parts
    .map((t) =>
      typeof t?.plain_text === "string"
        ? t.plain_text
        : typeof t?.text?.content === "string"
          ? t.text.content
          : "",
    )
    .join("");
};
const idValue = (value: unknown) => {
  const p = uuid.safeParse(value);
  if (!p.success)
    throw new AppError(
      "NOTION_IMPORT_INVALID",
      "Notion returned an invalid record identity.",
      502,
    );
  return p.data;
};
export function configuredImportBoundary() {
  const keys = [
    "NOTION_HUB_URL",
    "NOTION_IDEAS_URL",
    "NOTION_SOURCES_URL",
    "NOTION_EVALUATIONS_URL",
    "NOTION_REVIEWS_URL",
  ];
  try {
    return keys.map((k) => notionReference(envValue(k) ?? ""));
  } catch {
    throw new AppError(
      "IMPORT_BOUNDARY_REQUIRED",
      "Configure the Idea Lab hub and all four database URLs before importing other Notion content.",
      503,
    );
  }
}
export class NotionSelectionReader {
  private calls = 0;
  private cache = new Map<string, Meta>();
  private blocked: Set<string>;
  constructor(
    private transport: Transport,
    boundary: string[] = configuredImportBoundary(),
  ) {
    this.blocked = new Set(
      [
        ...boundary,
        transport.config.ideas,
        transport.config.sources,
        transport.config.evaluations,
        transport.config.reviews,
      ].map((v) => idValue(v)),
    );
  }
  private assertAllowed(id: string) {
    if (this.blocked.has(id))
      throw new AppError(
        "NOTION_SELF_IMPORT",
        "Idea Lab and its own databases cannot be imported as source content.",
        409,
      );
  }
  private async call(path: string, method = "GET", body?: unknown) {
    if (++this.calls > 120)
      throw new AppError(
        "NOTION_IMPORT_LIMIT",
        "This selection needs too many reads. Choose fewer or smaller pages.",
        413,
      );
    return this.transport.call(path, method, body);
  }
  private async meta(
    kind: "page" | "block" | "data_source" | "database",
    id: string,
    fullProperties = false,
  ): Promise<Meta> {
    this.assertAllowed(id);
    const key =
        kind + ":" + id + (kind === "page" && fullProperties ? ":full" : ""),
      existing =
        this.cache.get(key) ??
        (!fullProperties
          ? this.cache.get(kind + ":" + id + ":full")
          : undefined);
    if (existing) return existing;
    const route = {
      page: "pages",
      block: "blocks",
      data_source: "data_sources",
      database: "databases",
    }[kind];
    const raw = await this.call(
      route +
        "/" +
        id +
        (kind === "page" && !fullProperties ? "?filter_properties=title" : ""),
    );
    const p = metaSchema.safeParse(raw);
    if (!p.success || p.data.object !== kind || p.data.id !== id)
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "Notion returned different or incomplete metadata.",
        502,
      );
    if (p.data.archived || p.data.in_trash)
      throw new AppError(
        "NOT_FOUND",
        "This selected Notion content is archived or unavailable.",
        404,
      );
    this.cache.set(key, p.data);
    return p.data;
  }
  private async ancestry(start: Meta): Promise<Meta[]> {
    let current = start;
    const chain: Meta[] = [],
      seen = new Set<string>();
    for (let depth = 0; depth < 20; depth++) {
      this.assertAllowed(current.id);
      const key = current.object + ":" + current.id;
      if (seen.has(key))
        throw new AppError(
          "NOTION_IMPORT_INVALID",
          "The Notion ancestry contains a cycle.",
          502,
        );
      seen.add(key);
      chain.push(current);
      const parent = current.parent;
      if (parent.type === "workspace" && parent.workspace === true)
        return chain;
      const kinds = {
        page_id: "page",
        block_id: "block",
        database_id: "database",
        data_source_id: "data_source",
      } as const;
      const kind = kinds[parent.type as keyof typeof kinds];
      if (!kind)
        throw new AppError(
          "NOTION_IMPORT_BOUNDARY_UNKNOWN",
          "The selected content's ancestry could not be verified. No content was loaded.",
          409,
        );
      current = await this.meta(kind, idValue(parent[parent.type]));
    }
    throw new AppError(
      "NOTION_IMPORT_LIMIT",
      "The selected content has too many ancestors to verify safely.",
      413,
    );
  }
  private cleaned(text: string) {
    return redact(text, [this.transport.config.token]);
  }
  private title(raw: any) {
    const properties = raw.properties;
    if (properties && typeof properties === "object") {
      const title = Object.values(properties).find(
        (p: any) => p?.type === "title",
      ) as any;
      if (title)
        return (
          this.cleaned(plain(title.title)).slice(0, 200) ||
          "Untitled Notion page"
        );
    }
    return Array.isArray(raw.title)
      ? this.cleaned(plain(raw.title)).slice(0, 200) || "Untitled data source"
      : "Untitled Notion page";
  }
  private url(raw: any, id: string): string | null {
    if (typeof raw.url !== "string" || this.cleaned(raw.url) !== raw.url)
      return null;
    try {
      if (notionReference(raw.url) !== id) return null;
      const u = new URL(raw.url);
      u.search = "";
      u.hash = "";
      return u.href;
    } catch {
      return null;
    }
  }
  private revision(raw: any) {
    const p = dateSchema.safeParse(raw.last_edited_time);
    if (!p.success)
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "The selected content lacks a verifiable revision.",
        502,
      );
    return p.data;
  }
  private next(raw: any, seen: Set<string>, limit = 100): string | null {
    if (
      !Array.isArray(raw.results) ||
      raw.results.length > limit ||
      typeof raw.has_more !== "boolean"
    )
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "Notion returned an invalid page of results.",
        502,
      );
    if (!raw.has_more) return null;
    const c = raw.next_cursor;
    if (typeof c !== "string" || !c || c.length > 1000 || seen.has(c))
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "Notion returned repeated or invalid pagination.",
        502,
      );
    seen.add(c);
    return c;
  }
  async list(dataSourceId: string, cursor: string | null): Promise<NotionRows> {
    const source = await this.meta("data_source", dataSourceId);
    await this.ancestry(source);
    const raw = await this.call(
      "data_sources/" + dataSourceId + "/query?filter_properties=title",
      "POST",
      {
        page_size: 25,
        result_type: "page",
        ...(cursor ? { start_cursor: cursor } : {}),
      },
    );
    const nextCursor = this.next(raw, new Set(cursor ? [cursor] : []), 25),
      rows: NotionRows["rows"] = [];
    for (const item of raw.results) {
      const p = metaSchema.safeParse(item);
      if (
        !p.success ||
        p.data.object !== "page" ||
        p.data.parent.type !== "data_source_id" ||
        idValue(p.data.parent.data_source_id) !== dataSourceId
      )
        throw new AppError(
          "NOTION_IMPORT_INVALID",
          "A returned row is outside the selected data source.",
          502,
        );
      this.assertAllowed(p.data.id);
      if (p.data.archived || p.data.in_trash) continue;
      rows.push({
        id: p.data.id,
        title: this.title(item),
        url: this.url(item, p.data.id),
        revision: this.revision(item),
      });
    }
    return { dataSourceId, title: this.title(source), rows, nextCursor };
  }
  private async property(
    page: any,
    prop: any,
    type: "title" | "rich_text" | "relation",
    warnings: Set<string>,
  ) {
    let values = prop[type];
    if (!Array.isArray(values))
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "Notion returned an invalid property.",
        502,
      );
    if (type === "relation" && !prop.has_more) return values;
    if (typeof prop.id !== "string" || !prop.id)
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "A paginated property has no stable ID.",
        502,
      );
    values = [];
    let cursor: string | null = null;
    const seen = new Set<string>();
    let encoded: string;
    try {
      encoded = encodeURIComponent(decodeURIComponent(prop.id));
    } catch {
      throw new AppError(
        "NOTION_IMPORT_INVALID",
        "Notion returned an invalid property ID.",
        502,
      );
    }
    do {
      const raw = await this.call(
        "pages/" +
          page.id +
          "/properties/" +
          encoded +
          "?page_size=100" +
          (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""),
      );
      cursor = this.next(raw, seen);
      for (const value of raw.results) {
        if (value?.type !== type)
          throw new AppError(
            "NOTION_IMPORT_INVALID",
            "A property page contains unexpected values.",
            502,
          );
        const part = value[type];
        if (type === "relation") {
          idValue(part?.id);
          values.push(part);
        } else values.push(part);
      }
      if (values.length > 1000)
        throw new AppError(
          "NOTION_IMPORT_LIMIT",
          "A selected property is too large. Choose a smaller page.",
          413,
        );
    } while (cursor);
    warnings.add(
      "Text/relation properties were read through paginated endpoints. Related pages were not followed.",
    );
    return values;
  }
  async pages(
    pageIds: string[],
    readNested: boolean,
    dataSourceId?: string,
  ): Promise<ParsedImport> {
    if (dataSourceId) {
      const source = await this.meta("data_source", dataSourceId);
      await this.ancestry(source);
    }
    const conversations: Conversation[] = [],
      warnings = new Set<string>();
    let ignored = 0,
      blocks = 0,
      totalText = 0;
    for (const pageId of pageIds) {
      const page = await this.meta("page", pageId, true);
      await this.ancestry(page);
      if (
        dataSourceId &&
        (page.parent.type !== "data_source_id" ||
          idValue(page.parent.data_source_id) !== dataSourceId)
      )
        throw new AppError(
          "NOTION_SELECTION_CHANGED",
          "A selected row is outside the chosen data source.",
          409,
        );
      const pageRevision = this.revision(page),
        url = this.url(page, pageId),
        turns: Turn[] = [],
        seen = new Set<string>();
      const add = (
        messageId: string,
        text: string,
        revision: string,
        kind: "block" | "property",
        created?: string,
      ) => {
        if (!text.trim()) return;
        if (seen.has(messageId))
          throw new AppError(
            "NOTION_IMPORT_INVALID",
            "The selected page repeats a content identity.",
            502,
          );
        seen.add(messageId);
        totalText += text.length;
        if (text.length > 50000 || totalText > 300000)
          throw new AppError(
            "NOTION_IMPORT_LIMIT",
            "The selected text is too large. Choose fewer or smaller pages.",
            413,
          );
        turns.push({
          id: messageId,
          messageId,
          parentId: null,
          role: "document",
          text: this.cleaned(text),
          date: dateSchema.safeParse(created).success ? created! : null,
          originRevision: revision,
          locator: "Notion:" + pageId + "/" + kind + "/" + messageId,
          originalUrl: url
            ? kind === "block"
              ? url + "#" + messageId.replaceAll("-", "")
              : url
            : null,
        });
      };
      const props = (page as any).properties;
      if (!props || typeof props !== "object")
        throw new AppError(
          "NOTION_IMPORT_INVALID",
          "The page has no readable properties.",
          502,
        );
      for (const prop of Object.values(props) as any[]) {
        if (["title", "rich_text"].includes(prop?.type)) {
          if (typeof prop.id !== "string" || !prop.id)
            throw new AppError(
              "NOTION_IMPORT_INVALID",
              "A selected property has no stable ID.",
              502,
            );
          add(
            "property:" + prop.id,
            plain(await this.property(page, prop, prop.type, warnings)),
            pageRevision,
            "property",
            page.created_time,
          );
        } else if (prop?.type === "relation") {
          const values = await this.property(page, prop, "relation", warnings);
          for (const v of values) idValue(v?.id);
          warnings.add(
            "Relation references were counted but their linked pages were not loaded (" +
              values.length +
              " references).",
          );
        } else {
          ignored++;
          warnings.add("Non-text page properties were skipped.");
        }
      }
      const visitedBlocks = new Set<string>();
      const walk = async (parentId: string, depth: number) => {
        let cursor: string | null = null;
        const cursors = new Set<string>();
        do {
          const raw = await this.call(
            "blocks/" +
              parentId +
              "/children?page_size=100" +
              (cursor ? "&start_cursor=" + encodeURIComponent(cursor) : ""),
          );
          cursor = this.next(raw, cursors);
          for (const block of raw.results) {
            if (++blocks > 500)
              throw new AppError(
                "NOTION_IMPORT_LIMIT",
                "This selection contains too many blocks. Choose fewer or smaller pages.",
                413,
              );
            const id = idValue(block?.id);
            this.assertAllowed(id);
            if (
              block?.object !== "block" ||
              typeof block.type !== "string" ||
              typeof block.has_children !== "boolean"
            )
              throw new AppError(
                "NOTION_IMPORT_INVALID",
                "Notion returned an incomplete content block.",
                502,
              );
            if (visitedBlocks.has(id))
              throw new AppError(
                "NOTION_IMPORT_INVALID",
                "Notion repeated a block or returned a content cycle.",
                502,
              );
            visitedBlocks.add(id);
            const expected = depth === 0 ? "page_id" : "block_id";
            if (
              block.parent?.type !== expected ||
              idValue(block.parent[expected]) !== parentId
            )
              throw new AppError(
                "NOTION_IMPORT_INVALID",
                "A content block is outside the selected page tree.",
                502,
              );
            if (block.archived || block.in_trash) {
              ignored++;
              continue;
            }
            if (excluded.has(block.type)) {
              ignored++;
              warnings.add(
                "Skipped " +
                  block.type +
                  "; linked pages, synced content and attachments are never followed.",
              );
              continue;
            }
            if (textTypes.has(block.type))
              add(
                id,
                plain(block[block.type]?.rich_text),
                this.revision(block),
                "block",
                block.created_time,
              );
            else if (block.type === "table_row") {
              if (!Array.isArray(block.table_row?.cells))
                throw new AppError(
                  "NOTION_IMPORT_INVALID",
                  "A table row has invalid cells.",
                  502,
                );
              add(
                id,
                block.table_row.cells
                  .map((cell: any) => plain(cell))
                  .join(" | "),
                this.revision(block),
                "block",
                block.created_time,
              );
            } else if (!containers.has(block.type)) {
              ignored++;
              warnings.add(
                "Skipped unsupported block type: " + block.type + ".",
              );
              continue;
            }
            if (block.has_children) {
              if (!readNested) {
                warnings.add(
                  "Nested blocks were not loaded. Enable the nested-block option to include supported containers.",
                );
                continue;
              }
              if (depth >= 5)
                throw new AppError(
                  "NOTION_IMPORT_LIMIT",
                  "This page exceeds the nested-block depth limit.",
                  413,
                );
              await walk(id, depth + 1);
            }
          }
        } while (cursor);
      };
      await walk(pageId, 0);
      const final = metaSchema.safeParse(
        await this.call("pages/" + pageId + "?filter_properties=title"),
      );
      if (
        !final.success ||
        final.data.object !== "page" ||
        final.data.archived ||
        final.data.in_trash ||
        final.data.id !== pageId ||
        this.revision(final.data) !== pageRevision
      )
        throw new AppError(
          "NOTION_SELECTION_CHANGED",
          "The selected page changed while loading. Preview it again.",
          409,
        );
      this.cache.set("page:" + pageId, final.data);
      await this.ancestry(final.data);
      conversations.push({
        id: pageId,
        title: this.title(page),
        system: "Notion",
        url,
        adapterVersion: "notion-selected-v1",
        turns,
        branches: [
          {
            id: "page:" + pageId,
            label: "Selected page content",
            current: true,
            turnIds: turns.map((t) => t.id),
          },
        ],
      });
    }
    if (!conversations.some((c) => c.turns.length))
      warnings.add("No supported text was found in this selection.");
    warnings.add(
      "Only selected pages were read. No records were saved and no AI provider was called.",
    );
    return { conversations, warnings: [...warnings], ignored };
  }
  async verify(source: ImportSource) {
    const pageId = idValue(source.conversationId),
      page = await this.meta(
        "page",
        pageId,
        source.messageId.startsWith("property:"),
      );
    await this.ancestry(page);
    const isProperty = source.messageId.startsWith("property:"),
      pageURL = this.url(page, pageId),
      expectedURL = pageURL
        ? isProperty
          ? pageURL
          : pageURL + "#" + source.messageId.replaceAll("-", "")
        : null;
    if (
      source.originalUrl !== expectedURL ||
      source.locator !==
        "Notion:" +
          pageId +
          "/" +
          (isProperty ? "property" : "block") +
          "/" +
          source.messageId
    )
      throw new AppError(
        "NOTION_SOURCE_CHANGED",
        "The Notion provenance differs from the selected page or block.",
        409,
      );
    if (source.messageId.startsWith("property:")) {
      const propId = source.messageId.slice("property:".length),
        properties = (page as any).properties;
      if (
        !properties ||
        !Object.values(properties).some(
          (p: any) =>
            p?.id === propId && ["title", "rich_text"].includes(p.type),
        )
      )
        throw new AppError(
          "NOTION_SOURCE_CHANGED",
          "The selected property is no longer available.",
          409,
        );
      if (this.revision(page) !== source.originRevision)
        throw new AppError(
          "NOTION_SOURCE_CHANGED",
          "The Notion page changed after preview. Load and review it again.",
          409,
        );
    } else {
      const blockId = idValue(source.messageId),
        block = await this.meta("block", blockId);
      const chain = await this.ancestry(block),
        nearest = chain.find((m) => m.object === "page");
      if (
        nearest?.id !== pageId ||
        (!textTypes.has((block as any).type) &&
          (block as any).type !== "table_row")
      )
        throw new AppError(
          "NOTION_SOURCE_CHANGED",
          "The selected block is not supported content on this page.",
          409,
        );
      if (this.revision(block) !== source.originRevision)
        throw new AppError(
          "NOTION_SOURCE_CHANGED",
          "The selected Notion block changed after preview. Load and review it again.",
          409,
        );
    }
  }
}
export async function verifySelectedNotionSource(
  transport: Transport,
  source: ImportSource,
) {
  if (source.system === "Notion")
    await new NotionSelectionReader(transport).verify(source);
}
