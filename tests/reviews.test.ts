import { describe, it, expect, vi } from "vitest";
import {
  decisionCommandSchema,
  pairKey,
  fingerprint,
  sameContent,
  validateClassification,
  textOverlap,
  snapshotSchema,
  type PairContext,
  type RelationshipReview,
} from "../lib/reviews/model";
import { ReviewService } from "../lib/reviews/service";
import { ReviewRepository } from "../lib/reviews/repository";
import { Operations, digest } from "../lib/ideas/operations";
import { commandSchema } from "../lib/ideas/domain";
import { AppError } from "../lib/ideas/errors";
import { memoryDB, idea, ids, input } from "./fixtures";
const matchingId = "70000000-0000-4000-8000-000000000007",
  reviewId = "80000000-0000-4000-8000-000000000008",
  decisionId = "90000000-0000-4000-8000-000000000009";
const matching = {
  ...idea,
  id: matchingId,
  title: "Synthetic portable sensor demonstration",
  revision: "matching-revision",
  summary: "A reusable conference sensor demonstration.",
  problem: "Portable demonstrations need reusable components.",
};
async function contextFixture(pending = false): Promise<PairContext> {
  const key = await pairKey(idea.id, matching.id),
    candidateHash = await fingerprint(idea),
    matchingHash = await fingerprint(matching);
  const review: RelationshipReview = {
    id: reviewId,
    url: null,
    title: "Potential duplicate",
    status: "Pending",
    type: "potential duplicate",
    candidateId: idea.id,
    matchingId: matching.id,
    candidateRevision: idea.revision,
    matchingRevision: matching.revision,
    revision: "review-revision",
    pairKey: key,
    reasoning: "Both involve portable sensors.",
    recommendation: "Related",
    similarity: 0.72,
    decision: "",
    operation: "original-proposal-op",
    reviewedAt: null,
    updatedAt: idea.updatedAt,
    snapshot: null,
  };
  return {
    candidate: idea,
    matching,
    key,
    candidateHash,
    matchingHash,
    history: [],
    priorDecision: null,
    reopened: false,
    review: pending ? review : null,
    staleProposal: false,
  };
}
async function setup(pending = false) {
  const context = await contextFixture(pending),
    m = memoryDB(),
    ops = new Operations(m.db);
  const repo = {
    context: vi.fn().mockResolvedValue(context),
    appendDecision: vi.fn(
      async (command: any, ctx: PairContext, op: string) => ({
        ...ctx.review,
        id: decisionId,
        url: null,
        title: "Manual decision",
        status: ["Reject", "Distinct"].includes(command.decision)
          ? "Rejected"
          : "Approved",
        candidateId: idea.id,
        matchingId: matching.id,
        candidateRevision: idea.revision,
        matchingRevision: matching.revision,
        revision: "saved-revision",
        pairKey: ctx.key,
        decision: JSON.stringify({
          decision: command.decision,
          reason: command.reason,
          operation: op,
        }),
        operation: op,
        snapshot: snapshotSchema.parse({
          format: "idea-lab-relationship",
          version: 1,
          candidateId: idea.id,
          matchingId: matching.id,
          candidateRevision: idea.revision,
          matchingRevision: matching.revision,
          candidateHash: ctx.candidateHash,
          matchingHash: ctx.matchingHash,
          decision: command.decision,
          reason: command.reason,
          operation: op,
          origin: "manual",
          scope: "classification-only",
          originalReviewId: command.reviewId,
        }),
      }),
    ),
    closeOriginal: vi.fn(),
    findDecision: vi.fn().mockResolvedValue(null),
    review: vi.fn().mockResolvedValue(context.review),
  };
  const service = new ReviewService(repo as unknown as ReviewRepository, ops);
  const command = decisionCommandSchema.parse({
    candidateId: idea.id,
    matchingId: matching.id,
    candidateRevision: idea.revision,
    matchingRevision: matching.revision,
    reviewId: context.review?.id ?? null,
    reviewRevision: context.review?.revision ?? null,
    decision: "Related",
    reason: "Shared components, but different intended outcomes.",
  });
  return { context, m, ops, repo, service, command };
}
describe("relationship evidence and rejection memory", () => {
  it("uses stable unordered pair identity and normalizes canonical IDs", async () => {
    expect(await pairKey(idea.id, matching.id)).toBe(
      await pairKey(matching.id, idea.id),
    );
    expect(await pairKey(idea.id.toUpperCase(), matching.id)).toBe(
      await pairKey(idea.id, matching.id),
    );
    expect(
      decisionCommandSchema.safeParse({
        candidateId: idea.id,
        matchingId: idea.id.toUpperCase(),
        candidateRevision: "r",
        matchingRevision: "r",
        decision: "Distinct",
        reason: "same",
      }).success,
    ).toBe(false);
    expect(
      commandSchema.parse({
        action: "update",
        id: idea.id.toUpperCase(),
        expectedRevision: idea.revision,
        data: input,
      }).action,
    ).toBe("update");
  });
  it("preserves rejection memory across score/status changes but reopens changed content", async () => {
    const c = await contextFixture(),
      snapshot = snapshotSchema.parse({
        format: "idea-lab-relationship",
        version: 1,
        candidateId: idea.id,
        matchingId: matching.id,
        candidateRevision: idea.revision,
        matchingRevision: matching.revision,
        candidateHash: c.candidateHash,
        matchingHash: c.matchingHash,
        decision: "Distinct",
        reason: "Different outcomes.",
        operation: "a".repeat(64),
        origin: "manual",
        scope: "classification-only",
        originalReviewId: null,
      });
    const record = {
      ...(await contextFixture(true)).review!,
      snapshot,
      status: "Rejected" as const,
    };
    const changedScore = {
      ...idea,
      revision: "score-changed",
      status: "Active" as const,
      priorityScore: 95,
    };
    expect(await fingerprint(changedScore)).toBe(c.candidateHash);
    expect(sameContent(record, { ...c, candidate: changedScore })).toBe(true);
    expect(
      sameContent(record, {
        candidate: matching,
        matching: changedScore,
        candidateHash: c.matchingHash,
        matchingHash: c.candidateHash,
      }),
    ).toBe(true);
    const changed = {
      ...idea,
      problem: "A completely different audience problem.",
    };
    expect(
      sameContent(record, {
        ...c,
        candidate: changed,
        candidateHash: await fingerprint(changed),
      }),
    ).toBe(false);
    expect(
      sameContent(
        { ...record, snapshot: null },
        { ...c, candidate: changedScore },
      ),
    ).toBe(false);
  });
  it("requires exact evidence from both retrieved records and rejects model instructions", () => {
    const output = {
      relationship: "Related",
      reasoning: "Shared sensor context.",
      confidence: 0.7,
      evidence: [
        { ideaId: idea.id, field: "summary", quote: "portable sensor" },
        { ideaId: matching.id, field: "title", quote: "sensor demonstration" },
      ],
    };
    expect(validateClassification(output, idea, matching).relationship).toBe(
      "Related",
    );
    expect(() =>
      validateClassification({ ...output, merge: true }, idea, matching),
    ).toThrow();
    expect(() =>
      validateClassification(
        {
          ...output,
          evidence: [
            output.evidence[0],
            { ...output.evidence[1], quote: "invented claim" },
          ],
        },
        idea,
        matching,
      ),
    ).toThrow(/unsupported/);
    expect(() =>
      validateClassification(
        {
          ...output,
          evidence: [
            output.evidence[0],
            { ...output.evidence[1], ideaId: reviewId },
          ],
        },
        idea,
        matching,
      ),
    ).toThrow();
  });
  it("labels word overlap as a bounded lexical hint rather than a verdict", () => {
    expect(textOverlap(idea, matching).shared).toContain("sensor");
    expect(
      textOverlap(
        { ...idea, title: "the and app tool", summary: "", problem: "" },
        { ...idea, title: "the and app tool", summary: "", problem: "" },
      ).score,
    ).toBe(0);
    expect(textOverlap(idea, matching)).not.toHaveProperty("relationship");
  });
});
describe("shared multi-record approval coordination", () => {
  it("holds both idea locks and releases them only after completion", async () => {
    const m = memoryDB(),
      ops = new Operations(m.db),
      hash = await digest("pair"),
      a = await ops.issue("owner", hash, "review-decision", "pair:a", null),
      bhash = await digest("edit"),
      b = await ops.issue("owner", bhash, "update", matching.id, "r");
    await ops.claim(await ops.read(a.token, "owner"), hash, [
      idea.id,
      matching.id,
    ]);
    await expect(
      ops.claim(await ops.read(b.token, "owner"), bhash),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    await ops.finish(a.id, "done", decisionId);
    await expect(
      ops.claim(await ops.read(b.token, "owner"), bhash),
    ).resolves.toBe(true);
    m.close();
  });
  it("cleans partial acquisitions without deleting another operation's lock", async () => {
    const m = memoryDB(),
      ops = new Operations(m.db),
      hash = await digest("holder"),
      holder = await ops.issue("owner", hash, "update", "z-busy", null);
    await ops.claim(await ops.read(holder.token, "owner"), hash);
    const otherHash = await digest("pair"),
      pair = await ops.issue(
        "owner",
        otherHash,
        "review-decision",
        "pair:partial",
        null,
      );
    await expect(
      ops.claim(await ops.read(pair.token, "owner"), otherHash, [
        "a-first",
        "z-busy",
      ]),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    const nextHash = await digest("next"),
      next = await ops.issue("owner", nextHash, "update", "a-first", null);
    await expect(
      ops.claim(await ops.read(next.token, "owner"), nextHash),
    ).resolves.toBe(true);
    const blocked = await ops.issue(
      "owner",
      nextHash,
      "update",
      "z-busy",
      null,
    );
    await expect(
      ops.claim(await ops.read(blocked.token, "owner"), nextHash),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    m.close();
  });
  it("a simultaneous replay cannot clear the original operation's locks", async () => {
    const m = memoryDB(),
      ops = new Operations(m.db),
      hash = await digest("same"),
      a = await ops.issue("owner", hash, "review-decision", "pair:same", null),
      op = await ops.read(a.token, "owner");
    const results = await Promise.allSettled([
      ops.claim(op, hash, [idea.id, matching.id]),
      ops.claim(op, hash, [idea.id, matching.id]),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const h = await digest("edit"),
      b = await ops.issue("owner", h, "update", idea.id, "r");
    await expect(
      ops.claim(await ops.read(b.token, "owner"), h),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    m.close();
  });
});
describe("approved relationship decisions", () => {
  it("previews scope and evidence without writing and saves exactly once", async () => {
    const s = await setup(true),
      review = await s.service.prepare(s.command, "owner");
    expect(s.repo.appendDecision).not.toHaveBeenCalled();
    expect(s.repo.closeOriginal).not.toHaveBeenCalled();
    expect(review.changes.find((c) => c.field === "Scope")?.after).toContain(
      "No idea is merged",
    );
    const saved = await s.service.execute(
      s.command,
      review.approvalToken,
      "owner",
    );
    expect(saved.decisionId).toBe(decisionId);
    expect(s.repo.appendDecision).toHaveBeenCalledTimes(1);
    expect(s.repo.closeOriginal).toHaveBeenCalledTimes(1);
    expect(
      (await s.service.execute(s.command, review.approvalToken, "owner"))
        .replayed,
    ).toBe(true);
    expect(s.repo.appendDecision).toHaveBeenCalledTimes(1);
    s.m.close();
  });
  it("rejects stale idea/review inputs and payload substitutions before appending", async () => {
    const s = await setup(true),
      r = await s.service.prepare(s.command, "owner");
    await expect(
      s.service.execute(
        { ...s.command, decision: "Duplicate" },
        r.approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    s.repo.context.mockResolvedValue({
      ...s.context,
      review: { ...s.context.review!, revision: "changed" },
    });
    await expect(
      s.service.execute(s.command, r.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "STALE_REVIEW" });
    expect(s.repo.appendDecision).not.toHaveBeenCalled();
    s.repo.context.mockResolvedValue({
      ...s.context,
      candidate: { ...idea, revision: "new-revision" },
    });
    await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject({
      code: "STALE_IDEA",
    });
    s.m.close();
  });
  it("requires explicit reconsideration for a completed content pair", async () => {
    const s = await setup(),
      prior = {
        ...(await contextFixture(true)).review!,
        status: "Rejected" as const,
        decision: "Distinct",
      };
    s.repo.context.mockResolvedValue({
      ...s.context,
      priorDecision: prior,
      history: [prior],
    });
    await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject({
      code: "PAIR_ALREADY_REVIEWED",
    });
    await expect(
      s.service.prepare({ ...s.command, decision: "Reject" }, "owner"),
    ).rejects.toMatchObject({ code: "PAIR_ALREADY_REVIEWED" });
    await expect(
      s.service.prepare({ ...s.command, reconsider: true }, "owner"),
    ).resolves.toHaveProperty("approvalToken");
    s.m.close();
  });
  it("permits only rejecting an obsolete proposal and blocks resolved reviews", async () => {
    const s = await setup(true);
    s.repo.context.mockResolvedValue({ ...s.context, staleProposal: true });
    await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject({
      code: "STALE_PROPOSAL",
    });
    const r = await s.service.prepare(
      { ...s.command, decision: "Reject" },
      "owner",
    );
    expect(
      r.changes.find((c) => c.field === "Outdated suggestion"),
    ).toBeTruthy();
    s.repo.context.mockResolvedValue({
      ...s.context,
      review: { ...s.context.review!, status: "Approved" },
    });
    await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject({
      code: "STALE_REVIEW",
    });
    s.m.close();
  });
  it("keeps an appended decision and unresolved queue update uncertain until both are verified", async () => {
    const s = await setup(true),
      r = await s.service.prepare(s.command, "owner"),
      op = await s.ops.read(r.approvalToken, "owner");
    s.repo.closeOriginal.mockRejectedValue(
      new AppError("WRITE_UNCERTAIN", "lost response", 503, undefined, true),
    );
    await expect(
      s.service.execute(s.command, r.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    const decision = await s.repo.appendDecision.mock.results[0].value;
    s.repo.findDecision.mockResolvedValue(decision);
    expect((await s.service.reconcile(op.id, "owner")).status).toBe(
      "uncertain",
    );
    s.repo.review.mockResolvedValue({
      ...s.context.review!,
      status: "Approved",
      decision: JSON.stringify({ operation: op.id }),
    });
    expect((await s.service.reconcile(op.id, "owner")).status).toBe("done");
    expect(s.repo.appendDecision).toHaveBeenCalledTimes(1);
    await expect(s.service.reconcile(op.id, "other")).rejects.toMatchObject({
      status: 403,
    });
    s.m.close();
  });
  it("rejects superseded/mismatched records without classification writes", async () => {
    const s = await setup();
    s.repo.context.mockResolvedValue({
      ...s.context,
      candidate: { ...idea, canonicalIdeaId: matching.id },
    });
    await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject({
      code: "SUPERSEDED_IDEA",
    });
    s.repo.context.mockResolvedValue({
      ...s.context,
      candidate: { ...idea, id: reviewId },
    });
    await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject({
      code: "INVALID_PAIR",
    });
    expect(s.repo.appendDecision).not.toHaveBeenCalled();
    s.m.close();
  });
});
