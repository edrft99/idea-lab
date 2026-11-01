import { uuid } from "../ideas/domain";
import { NotionRepository, richText } from "../ideas/notion";
import { AppError } from "../ideas/errors";
import { digest } from "../ideas/operations";
import {
  pairKey,
  fingerprint,
  sameContent,
  snapshotSchema,
  type PairContext,
  type RelationshipReview,
  type DecisionCommand,
  type DecisionSnapshot,
} from "./model";
const plain = (p: any) =>
  (p?.title ?? p?.rich_text ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
const select = (p: any) => p?.select?.name ?? null;
const related = (p: any) =>
  (p?.relation ?? []).map((r: any) => {
    const id = uuid.safeParse(r.id);
    if (!id.success)
      throw new AppError(
        "REVIEW_RECORD_INVALID",
        "A review contains an invalid relation ID.",
        503,
      );
    return id.data;
  });
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
export class ReviewRepository extends NotionRepository {
  async preflight() {
    await this.schema(this.config.reviews, reviewTypes);
  }
  private async decode(page: any): Promise<RelationshipReview> {
    if (
      ["manual-link-v1", "manual-merge-v1"].includes(
        plain(page.properties["Classification Version"]),
      )
    )
      throw new AppError(
        "LINK_JOURNAL",
        "This is an approved action intent. Check completion in Recent Saves.",
        409,
      );
    const p = page.properties,
      candidates = related(p["Candidate Idea"]),
      matches = related(p["Potential Matching Idea"]),
      status = select(p.Status),
      similarity = p["Similarity Score"]?.number ?? null;
    if (
      candidates.length > 1 ||
      matches.length > 1 ||
      !["Pending", "Approved", "Rejected"].includes(status) ||
      (similarity !== null &&
        (!Number.isFinite(similarity) || similarity < 0 || similarity > 1))
    )
      throw new AppError(
        "REVIEW_RECORD_INVALID",
        "A review has unsupported status, relations or similarity values.",
        503,
      );
    const values = {
      id: page.id,
      url: page.url && /^https?:\/\//.test(page.url) ? page.url : null,
      title: plain(p.Name),
      status,
      type: select(p["Review Type"]),
      candidateId: candidates[0] ?? null,
      matchingId: matches[0] ?? null,
      candidateRevision: plain(p["Candidate Revision"]),
      matchingRevision: plain(p["Match Revision"]),
      pairKey: plain(p["Pair Key"]),
      reasoning: plain(p.Reasoning),
      recommendation: select(p["AI Recommendation"]),
      similarity,
      decision: plain(p["Reviewer Decision"]),
      operation: plain(p["Operation ID"]),
      reviewedAt: p["Reviewed Date"]?.date?.start ?? null,
      updatedAt: page.last_edited_time,
    };
    let snapshot: DecisionSnapshot | null = null;
    try {
      snapshot = snapshotSchema.parse(JSON.parse(plain(p["Proposal Payload"])));
      if (
        snapshot.candidateId !== values.candidateId ||
        snapshot.matchingId !== values.matchingId ||
        snapshot.candidateRevision !== values.candidateRevision ||
        snapshot.matchingRevision !== values.matchingRevision
      )
        snapshot = null;
    } catch {}
    return {
      ...values,
      status: status as RelationshipReview["status"],
      revision: await digest(
        JSON.stringify([
          values,
          page.last_edited_time,
          plain(p["Proposal Payload"]),
        ]),
      ),
      snapshot,
    };
  }
  async review(id: string) {
    await this.preflight();
    const page = await this.page(id, this.config.reviews);
    if (page.in_trash)
      throw new AppError("NOT_FOUND", "This review is unavailable.", 404);
    return this.decode(page);
  }
  async context(
    candidateId: string,
    matchingId: string,
    reviewId: string | null = null,
  ): Promise<PairContext> {
    await this.preflight();
    const candidate = await this.get(candidateId),
      matching = await this.get(matchingId),
      key = await pairKey(candidate.id, matching.id);
    if (candidate.id === matching.id)
      throw new AppError(
        "INVALID_PAIR",
        "Choose two different canonical ideas.",
        400,
      );
    const candidateHash = await fingerprint(candidate),
      matchingHash = await fingerprint(matching),
      rows = await this.query(this.config.reviews, {
        property: "Pair Key",
        rich_text: { equals: key },
      });
    const history: RelationshipReview[] = [];
    for (const page of rows) {
      if (
        ["manual-link-v1", "manual-merge-v1"].includes(
          plain(page.properties["Classification Version"]),
        )
      )
        continue;
      const r = await this.decode(page);
      if (
        (r.candidateId === candidate.id && r.matchingId === matching.id) ||
        (r.candidateId === matching.id && r.matchingId === candidate.id)
      )
        history.push(r);
    }
    history.sort(
      (a, b) =>
        (b.reviewedAt ?? b.updatedAt).localeCompare(
          a.reviewedAt ?? a.updatedAt,
        ) || a.id.localeCompare(b.id),
    );
    const completed = history.filter((r) => r.status !== "Pending"),
      partial = { candidate, matching, candidateHash, matchingHash };
    const priorDecision =
        completed.find((r) => sameContent(r, partial)) ?? null,
      review = reviewId ? await this.review(reviewId) : null;
    if (
      review &&
      (review.candidateId !== candidate.id || review.matchingId !== matching.id)
    )
      throw new AppError(
        "INVALID_REVIEW_PAIR",
        "The review references a different candidate or match.",
        409,
      );
    return {
      candidate,
      matching,
      key,
      candidateHash,
      matchingHash,
      history,
      priorDecision,
      reopened: completed.length > 0 && !priorDecision,
      review,
      staleProposal: !!review && !sameContent(review, partial),
    };
  }
  async contextForReview(id: string) {
    const review = await this.review(id);
    if (!review.candidateId || !review.matchingId)
      throw new AppError(
        "REVIEW_PAIR_REQUIRED",
        "This workflow needs both a saved candidate and a matching idea.",
        409,
      );
    return this.context(review.candidateId, review.matchingId, id);
  }
  async findDecision(operation: string) {
    const matches = await this.query(this.config.reviews, {
      property: "Operation ID",
      rich_text: { equals: operation },
    });
    if (matches.length > 1)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "Multiple review decisions reference this save.",
        409,
      );
    return matches[0] ? this.decode(matches[0]) : null;
  }
  async appendDecision(
    command: DecisionCommand,
    context: PairContext,
    operation: string,
    actor: string,
  ) {
    const existing = await this.findDecision(operation);
    if (existing) return existing;
    const schema = await this.schema(this.config.reviews, reviewTypes),
      staleRejection = context.staleProposal && command.decision === "Reject",
      original = context.review;
    const snapshot: DecisionSnapshot = {
      format: "idea-lab-relationship",
      version: 1,
      candidateId: context.candidate.id,
      matchingId: context.matching.id,
      candidateRevision: staleRejection
        ? original!.candidateRevision
        : command.candidateRevision,
      matchingRevision: staleRejection
        ? original!.matchingRevision
        : command.matchingRevision,
      candidateHash: staleRejection
        ? (original!.snapshot?.candidateHash ?? null)
        : context.candidateHash,
      matchingHash: staleRejection
        ? (original!.snapshot?.matchingHash ?? null)
        : context.matchingHash,
      decision: command.decision,
      reason: command.reason,
      operation,
      origin: "manual",
      scope: "classification-only",
      originalReviewId: command.reviewId,
    };
    // Legacy pending records can lack input revisions. Record that absence explicitly.
    const now = new Date().toISOString(),
      status = ["Reject", "Distinct"].includes(command.decision)
        ? "Rejected"
        : "Approved";
    const values: Record<string, unknown> = {
      Name: {
        title: [
          {
            type: "text",
            text: {
              content:
                "Manual " +
                command.decision +
                " review · " +
                context.candidate.title.slice(0, 100),
            },
          },
        ],
      },
      "Review Type": {
        select: {
          name:
            command.decision === "Related"
              ? "related idea"
              : command.decision === "Refinement"
                ? "idea refinement"
                : "potential duplicate",
        },
      },
      "Candidate Idea": { relation: [{ id: context.candidate.id }] },
      "Potential Matching Idea": { relation: [{ id: context.matching.id }] },
      "Similarity Score": { number: null },
      "AI Recommendation": { select: null },
      Reasoning: richText(command.reason),
      Status: { select: { name: status } },
      "Reviewer Decision": richText(
        JSON.stringify({
          decision: command.decision,
          reason: command.reason,
          operation,
          scope: "classification-only",
        }),
      ),
      "Reviewed Date": { date: { start: now } },
      Reviewer: richText(actor),
      "Candidate Revision": richText(snapshot.candidateRevision),
      "Match Revision": richText(snapshot.matchingRevision),
      "Pair Key": richText(context.key),
      "Proposal Payload": richText(JSON.stringify(snapshot)),
      "Embedding Version": richText("not-used"),
      "Classification Version": richText("manual-v1"),
      "Approval Hash": richText(operation),
      "Operation ID": richText(operation),
    };
    const journal = {
      ...snapshot,
      readCandidateRevision: command.candidateRevision,
      readMatchingRevision: command.matchingRevision,
      originalReviewRevision: command.reviewRevision,
      previousReviewerDecision: original?.decision ?? null,
      reconsidered: command.reconsider,
      priorDecisionId: context.priorDecision?.id ?? null,
      actor,
      time: now,
      staleRejection,
    };
    const raw = await this.call("pages", "POST", {
      parent: { type: "data_source_id", data_source_id: this.config.reviews },
      properties: Object.fromEntries(
        Object.entries(values).map(([name, value]) => [schema[name].id, value]),
      ),
      children: [
        {
          object: "block",
          type: "paragraph",
          paragraph: richText(
            "Classification only. No idea was merged, linked, edited or deleted.",
          ),
        },
        {
          object: "block",
          type: "code",
          code: {
            language: "json",
            ...richText(JSON.stringify(journal, null, 2)),
          },
        },
      ],
    });
    try {
      const saved = await this.decode(this.checked(raw, this.config.reviews));
      if (
        !saved.snapshot ||
        saved.operation !== operation ||
        saved.candidateId !== context.candidate.id ||
        saved.matchingId !== context.matching.id
      )
        throw new Error("Invalid decision response");
      return saved;
    } catch {
      throw new AppError(
        "WRITE_UNCERTAIN",
        "The review decision could not be verified. Check its status before another save.",
        503,
        undefined,
        true,
      );
    }
  }
  async closeOriginal(
    command: DecisionCommand,
    operation: string,
    decision: RelationshipReview,
    actor: string,
  ) {
    if (!command.reviewId) return;
    const original = await this.review(command.reviewId);
    if (original.status !== "Pending") {
      try {
        if (
          JSON.parse(original.decision).operation === operation &&
          original.status === decision.status
        )
          return;
      } catch {}
      throw new AppError(
        "STALE_REVIEW",
        "The original review was already resolved by another decision.",
        409,
      );
    }
    if (original.revision !== command.reviewRevision)
      throw new AppError(
        "STALE_REVIEW",
        "The original review changed. Its new state was preserved; the appended decision remains in history.",
        409,
      );
    const schema = await this.schema(this.config.reviews, reviewTypes),
      values: Record<string, unknown> = {
        Status: { select: { name: decision.status } },
        "Reviewer Decision": richText(
          JSON.stringify({
            decision: command.decision,
            reason: command.reason,
            operation,
            decisionId: decision.id,
            scope: "classification-only",
          }),
        ),
        Reviewer: richText(actor),
        "Reviewed Date": { date: { start: new Date().toISOString() } },
        "Approval Hash": richText(operation),
      };
    await this.call("pages/" + original.id, "PATCH", {
      properties: Object.fromEntries(
        Object.entries(values).map(([name, value]) => [schema[name].id, value]),
      ),
    });
  }
}
