import { AppError } from "../ideas/errors";
import { NotionRepository, richText } from "../ideas/notion";
import { sameIds } from "../links/model";
import { type Idea } from "../ideas/domain";
import {
  mergeJournalSchema,
  type MergeJournal,
  mergeContentHash,
  originalSnapshot,
  desiredRelated,
} from "./model";
const plain = (p: any) =>
  (p?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
const journalTypes: Record<string, string> = {
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
};
export class MergeRepository extends NotionRepository {
  async preflight() {
    const raw = await this.call("data_sources/" + this.config.ideas);
    for (const name of ["Related Ideas", "Canonical Idea"]) {
      const prop = raw.properties?.[name],
        rel = prop?.relation;
      if (
        prop?.type !== "relation" ||
        rel?.data_source_id !== this.config.ideas ||
        rel?.type !== "single_property"
      )
        throw new AppError(
          "MERGE_SCHEMA_UNSUPPORTED",
          "Related Ideas and Canonical Idea must be one-way self relations to the configured Ideas data source.",
          503,
        );
    }
    await this.schema(this.config.reviews, journalTypes);
  }
  journalBody(journal: MergeJournal, ideas: Idea[]) {
    const values: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                "Approved merge intent · " + journal.operation.slice(0, 12),
            },
          },
        ],
      },
      "Review Type": { select: { name: "potential duplicate" } },
      "Candidate Idea": {
        relation: journal.command.candidates.map((c) => ({ id: c.id })),
      },
      "Potential Matching Idea": {
        relation: [{ id: journal.command.survivorId }],
      },
      Status: { select: { name: "Approved" } },
      "Reviewer Decision": richText(
        "Approved merge intent. Completion must be checked on every participant; this journal does not prove that all steps finished.",
      ),
      Reasoning: richText(journal.command.reason),
      Reviewer: richText(journal.actor),
      "Reviewed Date": { date: { start: new Date().toISOString() } },
      "Candidate Revision": richText(
        JSON.stringify(journal.command.candidates),
      ),
      "Match Revision": richText(journal.command.survivorRevision),
      "Pair Key": richText("merge:" + journal.operation),
      "Proposal Payload": richText(JSON.stringify(journal)),
      "Classification Version": richText("manual-merge-v1"),
      "Approval Hash": richText(journal.operation),
      "Operation ID": richText(journal.operation),
    };
    const children = [
      {
        object: "block",
        type: "paragraph",
        paragraph: richText(
          "Approved non-destructive merge intent. The named survivor keeps its description and selected score. Candidates remain readable, are archived, and point to the survivor. Original sources and immutable evaluations stay on their original records and are aggregated by canonical lineage in Idea Lab. Snapshots below preserve the approved originals. Check completion and explicitly resume interrupted steps in Recent Saves.",
        ),
      },
      ...ideas.map((i) => ({
        object: "block",
        type: "code",
        code: {
          language: "json",
          ...richText(JSON.stringify(originalSnapshot(i), null, 2)),
        },
      })),
    ];
    const body = {
      parent: { type: "data_source_id", data_source_id: this.config.reviews },
      properties: values,
      children,
    };
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength > 400000 ||
      Object.values(values).some((v: any) => v?.rich_text?.length > 100) ||
      children.some((v: any) => v.code?.rich_text?.length > 100)
    )
      throw new AppError(
        "MERGE_SIZE_LIMIT",
        "The preserved snapshots are too large for one safe merge journal. Review fewer candidates at a time.",
        400,
      );
    return body;
  }
  async appendJournal(journal: MergeJournal, ideas: Idea[]) {
    const schema = await this.schema(this.config.reviews, journalTypes),
      body = this.journalBody(journal, ideas);
    const raw = await this.call("pages", "POST", {
      ...body,
      properties: Object.fromEntries(
        Object.entries(body.properties).map(([n, v]) => [schema[n].id, v]),
      ),
    });
    try {
      const row = this.checked(raw, this.config.reviews);
      if (
        plain(row.properties["Operation ID"]) !== journal.operation ||
        plain(row.properties["Proposal Payload"]) !== JSON.stringify(journal)
      )
        throw new Error("Invalid merge journal response");
      return { id: row.id, journal };
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The merge intent could not be confirmed. Check the save before another attempt.",
        503,
        undefined,
        true,
      );
    }
  }
  async findJournal(operation: string) {
    const rows = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple merge journals reference this save.",
        409,
      );
    if (!rows[0]) return null;
    try {
      const row = rows[0],
        journal = mergeJournalSchema.parse(
          JSON.parse(plain(row.properties["Proposal Payload"])),
        );
      const candidates = (row.properties["Candidate Idea"]?.relation ?? []).map(
        (r: any) => r.id,
      );
      const survivors = (
        row.properties["Potential Matching Idea"]?.relation ?? []
      ).map((r: any) => r.id);
      if (
        journal.operation !== operation ||
        plain(row.properties["Classification Version"]) !== "manual-merge-v1" ||
        row.properties.Status?.select?.name !== "Approved" ||
        !sameIds(
          candidates,
          journal.command.candidates.map((c) => c.id),
        ) ||
        !sameIds(survivors, [journal.command.survivorId])
      )
        throw new Error("Invalid merge journal");
      return { id: row.id, journal };
    } catch {
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The merge journal cannot be verified. Preserve the partial state and inspect Notion.",
        409,
      );
    }
  }
  async state(journal: MergeJournal, index: number) {
    const before = journal.before[index],
      idea = await this.get(before.id);
    if ((await mergeContentHash(idea)) !== before.contentHash)
      throw new AppError(
        "MERGE_CONFLICT",
        "An idea's description, scores or source references changed. The partial merge is preserved; inspect Notion before recovery.",
        409,
      );
    const related = desiredRelated(journal, index),
      status = index === 0 ? before.status : "Archived",
      canonical = index === 0 ? null : journal.command.survivorId;
    const applied =
      idea.revision.split("@")[0].endsWith(";revision:" + journal.operation) &&
      idea.status === status &&
      idea.canonicalIdeaId === canonical &&
      sameIds(idea.relatedIdeaIds, related);
    if (applied) return { idea, applied: true };
    if (
      idea.revision !== before.revision ||
      idea.status !== before.status ||
      idea.canonicalIdeaId !== before.canonicalId ||
      !sameIds(idea.relatedIdeaIds, before.related)
    )
      throw new AppError(
        "MERGE_CONFLICT",
        "An input changed after merge approval. No changed record will be overwritten.",
        409,
      );
    return { idea, applied: false };
  }
  async states(journal: MergeJournal) {
    const states = [];
    for (let n = 0; n < journal.before.length; n++)
      states.push(await this.state(journal, n));
    return states;
  }
  async apply(journal: MergeJournal, index: number) {
    // Recheck every participant before each step, including previously applied ones.
    const states = await this.states(journal),
      state = states[index];
    if (state.applied) return;
    const schema = await this.schema(this.config.ideas),
      idea = state.idea;
    const marker =
      idea.revision.split("@")[0].split(";")[0] || "legacy:" + idea.id;
    const values: Record<string, unknown> = {
      "Record Version": richText(marker + ";revision:" + journal.operation),
      "Approved By": richText(journal.actor),
      "Approved At": { date: { start: new Date().toISOString() } },
      ...(index === 0
        ? {
            "Related Ideas": {
              relation: desiredRelated(journal, index).map((id) => ({ id })),
            },
          }
        : {
            Status: { select: { name: "Archived" } },
            "Canonical Idea": {
              relation: [{ id: journal.command.survivorId }],
            },
          }),
    };
    await this.call("pages/" + idea.id, "PATCH", {
      properties: Object.fromEntries(
        Object.entries(values).map(([n, v]) => [schema[n].id, v]),
      ),
    });
    if (!(await this.state(journal, index)).applied)
      throw new AppError(
        "WRITE_UNCERTAIN",
        "This merge step was not confirmed. Check the save before retrying.",
        503,
        undefined,
        true,
      );
  }
}
