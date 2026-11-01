import { AppError } from "../ideas/errors";
import { NotionRepository, richText } from "../ideas/notion";
import { digest } from "../ideas/operations";
import { sourceKey, sourceRevision } from "../imports/provenance";
import { uuid } from "../ideas/domain";
import {
  storedProposalSchema,
  proposalIntentSchema,
  decisionRecordSchema,
  type StoredProposal,
  type ExtractionProposal,
  type ProposalIntent,
} from "./model";
const plain = (p: any) =>
  (p?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
export const reviewTypes: Record<string, string> = {
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
export const proposalKey = (key: string) => "extraction:" + key;
export class ProposalRepository extends NotionRepository {
  async preflight() {
    await this.schema(this.config.reviews, reviewTypes);
  }
  private async checkedSnapshot(raw: unknown): Promise<StoredProposal> {
    const snapshot = storedProposalSchema.parse(raw);
    if (
      snapshot.commandHash !==
        (await digest(JSON.stringify(snapshot.command))) ||
      snapshot.sourceKey !== (await sourceKey(snapshot.command.source)) ||
      snapshot.sourceRevision !==
        (await sourceRevision(snapshot.command.source))
    )
      throw new AppError(
        "PROPOSAL_INVALID",
        "The stored proposal's identity or content cannot be verified.",
        409,
      );
    return snapshot;
  }
  private async decode(row: any): Promise<ExtractionProposal> {
    try {
      const p = row.properties;
      if (
        plain(p["Classification Version"]) !== "extraction-proposal-v1" ||
        p["Review Type"]?.select?.name !== "uncertain extraction"
      )
        throw new Error("Unsupported proposal");
      const snapshot = await this.checkedSnapshot(
          JSON.parse(plain(p["Proposal Payload"])),
        ),
        status = p.Status?.select?.name,
        candidates = (p["Candidate Idea"]?.relation ?? []).map((r: any) =>
          uuid.parse(r.id),
        );
      if (
        !["Pending", "Approved", "Rejected"].includes(status) ||
        candidates.length > 1 ||
        (p["Potential Matching Idea"]?.relation ?? []).length ||
        plain(p["Operation ID"]) !== snapshot.operation ||
        plain(p["Pair Key"]) !== proposalKey(snapshot.sourceKey) ||
        plain(p["Candidate Revision"]) !== snapshot.sourceRevision
      )
        throw new Error("Invalid metadata");
      const decision =
        status === "Pending"
          ? null
          : decisionRecordSchema.parse(
              JSON.parse(plain(p["Reviewer Decision"])),
            );
      if (
        status === "Pending" &&
        (candidates.length || plain(p["Reviewer Decision"]))
      )
        throw new Error("Unexpected pending result");
      if (
        decision &&
        ((status === "Approved") !== (decision.decision === "Approve") ||
          decision.ideaId !== (candidates[0] ?? null))
      )
        throw new Error("Mismatched decision");
      return {
        id: row.id,
        url:
          typeof row.url === "string" && /^https?:\/\//.test(row.url)
            ? row.url
            : null,
        status,
        snapshot,
        decision,
        canonicalIdeaId: candidates[0] ?? null,
        revision: await digest(
          JSON.stringify([
            row.id,
            row.last_edited_time,
            snapshot,
            status,
            candidates,
            plain(p["Reviewer Decision"]),
            plain(p.Reviewer),
            p["Reviewed Date"]?.date?.start ?? null,
            plain(p["Approval Hash"]),
            plain(p.Reasoning),
            (p.Name?.title ?? [])
              .map((t: any) => t.plain_text ?? t.text?.content ?? "")
              .join(""),
          ]),
        ),
      };
    } catch {
      throw new AppError(
        "PROPOSAL_INVALID",
        "This extraction proposal has unsupported or inconsistent metadata. Inspect it in Notion before editing.",
        409,
      );
    }
  }
  async proposal(id: string) {
    await this.preflight();
    const row = await this.page(id, this.config.reviews);
    if (row.in_trash)
      throw new AppError("NOT_FOUND", "This proposal is unavailable.", 404);
    return this.decode(row);
  }
  async history(key: string, hint: string | null = null) {
    await this.preflight();
    const rows = await this.query(this.config.reviews, {
      property: "Pair Key",
      rich_text: { equals: proposalKey(key) },
    });
    const result: ExtractionProposal[] = [];
    for (const row of rows)
      if (
        plain(row.properties["Classification Version"]) ===
        "extraction-proposal-v1"
      )
        result.push(await this.decode(row));
    if (hint && !result.some((p) => p.id === hint)) {
      const saved = await this.proposal(uuid.parse(hint));
      if (saved.snapshot.sourceKey !== key)
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "The proposal index points to a different source.",
          409,
        );
      result.push(saved);
    }
    return result;
  }
  async findStored(operation: string) {
    const rows = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple proposals reference this save.",
        409,
      );
    return rows[0] ? this.decode(rows[0]) : null;
  }
  private values(snapshot: StoredProposal | ProposalIntent, status: string) {
    const stored = snapshot.format === "idea-lab-extraction-proposal",
      proposal = stored ? snapshot : snapshot.proposal,
      command = proposal.command,
      reason = stored ? command.note : snapshot.command.reason,
      now = new Date().toISOString();
    return {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                (stored
                  ? "Extraction proposal · "
                  : "Extraction decision intent · ") +
                command.data.title.slice(0, 140),
            },
          },
        ],
      },
      "Review Type": { select: { name: "uncertain extraction" } },
      "Candidate Idea": { relation: [] },
      "Potential Matching Idea": { relation: [] },
      "Similarity Score": { number: null },
      "AI Recommendation": { select: null },
      Reasoning: richText(reason),
      Status: { select: { name: status } },
      "Reviewer Decision": richText(""),
      "Reviewed Date": stored ? { date: null } : { date: { start: now } },
      Reviewer: richText(snapshot.actor),
      "Candidate Revision": richText(proposal.sourceRevision),
      "Match Revision": richText(""),
      "Pair Key": richText(
        stored
          ? proposalKey(proposal.sourceKey)
          : "extraction-intent:" + snapshot.operation,
      ),
      "Proposal Payload": richText(JSON.stringify(snapshot)),
      "Embedding Version": richText("not-used"),
      "Classification Version": richText(
        stored ? "extraction-proposal-v1" : "extraction-intent-v1",
      ),
      "Approval Hash": richText(snapshot.operation),
      "Operation ID": richText(snapshot.operation),
    };
  }
  body(snapshot: StoredProposal | ProposalIntent) {
    const stored = snapshot.format === "idea-lab-extraction-proposal";
    const body = {
      parent: { type: "data_source_id", data_source_id: this.config.reviews },
      properties: this.values(
        snapshot,
        stored
          ? "Pending"
          : snapshot.command.decision === "Reject"
            ? "Rejected"
            : "Approved",
      ),
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: richText(
            stored
              ? "Selected extraction proposal only. This is not a canonical idea. Approval or rejection requires a separate reviewed action."
              : "Reviewed decision intent. This row alone does not prove canonical capture or original queue resolution. Check the operation before retrying.",
          ),
        },
        {
          object: "block",
          type: "code",
          code: {
            language: "json",
            ...richText(JSON.stringify(snapshot, null, 2)),
          },
        },
      ],
    };
    if (
      new TextEncoder().encode(JSON.stringify(body)).byteLength > 400000 ||
      Object.values(body.properties).some(
        (v: any) => v.rich_text?.length > 100,
      ) ||
      body.children.some((b: any) => b.code?.rich_text?.length > 100)
    )
      throw new AppError(
        "PROPOSAL_TOO_LARGE",
        "This proposal is too large to preserve safely. Shorten the selected fields.",
        400,
      );
    return body;
  }
  private async append(snapshot: StoredProposal | ProposalIntent) {
    const schema = await this.schema(this.config.reviews, reviewTypes),
      body = this.body(snapshot);
    const raw = await this.call("pages", "POST", {
      ...body,
      properties: Object.fromEntries(
        Object.entries(body.properties).map(([n, v]) => [schema[n].id, v]),
      ),
    });
    try {
      const row = this.checked(raw, this.config.reviews);
      if (
        plain(row.properties["Proposal Payload"]) !==
          JSON.stringify(snapshot) ||
        plain(row.properties["Operation ID"]) !== snapshot.operation
      )
        throw new Error("Invalid response");
      return row;
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The proposal history save could not be confirmed. Check this operation before another save.",
        503,
        undefined,
        true,
      );
    }
  }
  async appendProposal(snapshot: StoredProposal) {
    return this.decode(await this.append(snapshot));
  }
  async appendIntent(snapshot: ProposalIntent) {
    const row = await this.append(snapshot);
    return { id: row.id, snapshot };
  }
  async findIntent(operation: string) {
    const rows = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (rows.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple decision intents reference this save.",
        409,
      );
    if (!rows[0]) return null;
    try {
      const row = rows[0],
        snapshot = proposalIntentSchema.parse(
          JSON.parse(plain(row.properties["Proposal Payload"])),
        );
      await this.checkedSnapshot(snapshot.proposal);
      if (
        snapshot.operation !== operation ||
        plain(row.properties["Classification Version"]) !==
          "extraction-intent-v1" ||
        row.properties.Status?.select?.name !==
          (snapshot.command.decision === "Reject" ? "Rejected" : "Approved")
      )
        throw new Error("Invalid intent");
      return { id: row.id, snapshot };
    } catch {
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The extraction decision intent cannot be verified.",
        409,
      );
    }
  }
  async close(
    intent: { id: string; snapshot: ProposalIntent },
    ideaId: string | null,
  ) {
    const j = intent.snapshot,
      original = await this.proposal(j.command.proposalId);
    if (
      original.decision?.decision === j.command.decision &&
      original.decision?.reason === j.command.reason &&
      original.decision?.operation === j.operation &&
      original.decision.intentId === intent.id &&
      original.decision.ideaId === ideaId
    )
      return;
    if (
      original.status !== "Pending" ||
      original.revision !== j.command.proposalRevision
    )
      throw new AppError(
        "STALE_PROPOSAL",
        "The saved proposal changed. Its history and any completed capture are preserved.",
        409,
      );
    const schema = await this.schema(this.config.reviews, reviewTypes),
      decision = decisionRecordSchema.parse({
        decision: j.command.decision,
        reason: j.command.reason,
        operation: j.operation,
        intentId: intent.id,
        ideaId,
      });
    const values = {
      "Candidate Idea": { relation: ideaId ? [{ id: ideaId }] : [] },
      Status: { select: { name: ideaId ? "Approved" : "Rejected" } },
      "Reviewer Decision": richText(JSON.stringify(decision)),
      Reviewer: richText(j.actor),
      "Reviewed Date": { date: { start: new Date().toISOString() } },
      "Approval Hash": richText(j.operation),
    };
    await this.call("pages/" + original.id, "PATCH", {
      properties: Object.fromEntries(
        Object.entries(values).map(([n, v]) => [schema[n].id, v]),
      ),
    });
    const saved = await this.proposal(original.id);
    if (
      saved.decision?.decision !== j.command.decision ||
      saved.decision?.reason !== j.command.reason ||
      saved.decision?.operation !== j.operation ||
      saved.decision.intentId !== intent.id ||
      saved.decision.ideaId !== ideaId
    )
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The proposal resolution was not confirmed. Check its status.",
        503,
        undefined,
        true,
      );
  }
}
