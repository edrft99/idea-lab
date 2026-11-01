import { NotionRepository, decodeIdea, richText } from "../ideas/notion";
import { AppError } from "../ideas/errors";
import {
  linkJournalSchema,
  type LinkJournal,
  linkedIds,
  sameIds,
  linkContentHash,
} from "./model";
const plain = (p: any) =>
  (p?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
export class LinkRepository extends NotionRepository {
  async preflight() {
    const raw = await this.call("data_sources/" + this.config.ideas);
    const relation = raw.properties?.["Related Ideas"]?.relation;
    if (
      raw.properties?.["Related Ideas"]?.type !== "relation" ||
      relation?.type !== "single_property" ||
      relation?.data_source_id !== this.config.ideas
    )
      throw new AppError(
        "LINK_SCHEMA_UNSUPPORTED",
        "Related Ideas must be a one-way self relation to the configured Ideas data source. No changes were made.",
        503,
      );
    await this.schema(this.config.reviews, {
      Name: "title",
      "Review Type": "select",
      "Candidate Idea": "relation",
      "Potential Matching Idea": "relation",
      Status: "select",
      "Reviewer Decision": "rich_text",
      "Reviewed Date": "date",
      Reviewer: "rich_text",
      "Candidate Revision": "rich_text",
      "Match Revision": "rich_text",
      "Pair Key": "rich_text",
      "Proposal Payload": "rich_text",
      "Classification Version": "rich_text",
      "Approval Hash": "rich_text",
      "Operation ID": "rich_text",
      Reasoning: "rich_text",
    });
  }
  async findJournal(
    operation: string,
  ): Promise<{ id: string; journal: LinkJournal } | null> {
    const rows = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple journals reference this link save.",
        409,
      );
    if (!rows[0]) return null;
    try {
      const row = rows[0],
        journal = linkJournalSchema.parse(
          JSON.parse(plain(row.properties["Proposal Payload"])),
        );
      if (
        journal.operation !== operation ||
        plain(row.properties["Classification Version"]) !== "manual-link-v1" ||
        row.properties.Status?.select?.name !== "Approved" ||
        row.properties["Candidate Idea"]?.relation?.[0]?.id !==
          journal.command.candidateId ||
        row.properties["Potential Matching Idea"]?.relation?.[0]?.id !==
          journal.command.matchingId
      )
        throw new Error("Invalid journal");
      return { id: row.id, journal };
    } catch {
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The link journal cannot be verified. Inspect it in Notion before another save.",
        409,
      );
    }
  }
  async appendJournal(journal: LinkJournal) {
    const schema = await this.schema(this.config.reviews);
    const values: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                "Approved related link · " + journal.operation.slice(0, 12),
            },
          },
        ],
      },
      "Review Type": { select: { name: "related idea" } },
      "Candidate Idea": { relation: [{ id: journal.command.candidateId }] },
      "Potential Matching Idea": {
        relation: [{ id: journal.command.matchingId }],
      },
      Status: { select: { name: "Approved" } },
      "Reviewer Decision": richText(
        "Approved link intent. Completion is verified against both idea records; this journal alone does not prove completion.",
      ),
      Reasoning: richText(journal.command.reason),
      Reviewer: richText(journal.actor),
      "Reviewed Date": { date: { start: new Date().toISOString() } },
      "Candidate Revision": richText(journal.command.candidateRevision),
      "Match Revision": richText(journal.command.matchingRevision),
      "Pair Key": richText("link:" + journal.operation),
      "Proposal Payload": richText(JSON.stringify(journal)),
      "Classification Version": richText("manual-link-v1"),
      "Approval Hash": richText(journal.operation),
      "Operation ID": richText(journal.operation),
    };
    const raw = await this.call("pages", "POST", {
      parent: { type: "data_source_id", data_source_id: this.config.reviews },
      properties: Object.fromEntries(
        Object.entries(values).map(([k, v]) => [schema[k].id, v]),
      ),
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: richText(
            "Approved related-link intent. Preserve this journal. A partial save may leave one side linked; use Recent Saves to check and explicitly resume. No merge or score change is authorized.",
          ),
        },
      ],
    });
    try {
      const saved = this.checked(raw, this.config.reviews);
      if (
        plain(saved.properties["Operation ID"]) !== journal.operation ||
        plain(saved.properties["Proposal Payload"]) !== JSON.stringify(journal)
      )
        throw new Error("Invalid response");
      return { id: saved.id, journal };
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The link journal save could not be confirmed. Check this save before retrying.",
        503,
        undefined,
        true,
      );
    }
  }
  async state(journal: LinkJournal, index: 0 | 1) {
    const before = journal.before[index],
      idea = await this.get(before.id);
    if (
      idea.canonicalIdeaId ||
      (await linkContentHash(idea)) !== before.contentHash
    )
      throw new AppError(
        "LINK_CONFLICT",
        "An idea's content, scores, sources or canonical identity changed. Preserve the partial link and inspect it in Notion.",
        409,
      );
    const applied =
      idea.revision.split("@")[0].endsWith(";revision:" + journal.operation) &&
      sameIds(idea.relatedIdeaIds, linkedIds(journal, index));
    if (applied) return { idea, applied: true };
    if (
      idea.revision !== before.revision ||
      !sameIds(idea.relatedIdeaIds, before.related)
    )
      throw new AppError(
        "LINK_CONFLICT",
        "An idea changed since approval. No changed record will be overwritten; inspect this save in Notion.",
        409,
      );
    return { idea, applied: false };
  }
  async apply(journal: LinkJournal, index: 0 | 1) {
    const state = await this.state(journal, index);
    if (state.applied) return;
    const schema = await this.schema(this.config.ideas),
      before = state.idea;
    const marker =
      before.revision.split("@")[0].split(";")[0] || "legacy:" + before.id;
    await this.call("pages/" + before.id, "PATCH", {
      properties: {
        [schema["Related Ideas"].id]: {
          relation: linkedIds(journal, index).map((id) => ({ id })),
        },
        [schema["Record Version"].id]: richText(
          marker + ";revision:" + journal.operation,
        ),
        [schema["Approved By"].id]: richText(journal.actor),
        [schema["Approved At"].id]: {
          date: { start: new Date().toISOString() },
        },
      },
    });
    if (!(await this.state(journal, index)).applied)
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The related link could not be confirmed.",
        503,
        undefined,
        true,
      );
  }
}
