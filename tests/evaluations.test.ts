import { describe, it, expect, vi } from "vitest";
import {
  defaultWeights,
  potential,
  evaluationDraftSchema,
  evaluationCommandSchema,
  aiAssessmentSchema,
  decodeDraftFile,
  type EvaluationDraft,
} from "../lib/evaluations/model";
import { EvaluationService } from "../lib/evaluations/service";
import { EvaluationRepository } from "../lib/evaluations/repository";
import { Operations, digest } from "../lib/ideas/operations";
import { AppError } from "../lib/ideas/errors";
import { scoreFromRatings } from "../lib/ideas/domain";
import { memoryDB, idea, ids } from "./fixtures";
export const assessment: EvaluationDraft = {
  rubricVersion: "potential-v1",
  weights: defaultWeights,
  ratings: {
    impact: 4,
    alignment: 3,
    feasibility: 4,
    reusability: 5,
    timing: 2,
  },
  evidence: {
    impact: "Useful to several teams.",
    alignment: "Fits the stated demo goal.",
    feasibility: "A prototype is plausible.",
    reusability: "Multiple reusable parts.",
    timing: "No deadline is known.",
  },
  rationale: "A promising demonstration with uncertain timing.",
  benefits: "Reusable examples.",
  risks: "Integration complexity.",
  assumptions: "Components remain available.",
  effort: "Weekend",
  readiness: "Ready to explore",
  confidence: 0.7,
  nextAction: "Validate the smallest prototype.",
};
function setup() {
  const m = memoryDB(),
    ops = new Operations(m.db),
    evaluated = {
      ...idea,
      priorityScore: 50,
      scoreAuthority: "manual-approved",
      scores: {
        impact: 3,
        alignment: 3,
        feasibility: 3,
        reusability: 3,
        timing: 3,
      },
    };
  const repo = {
    get: vi.fn().mockResolvedValue(evaluated),
    preflight: vi.fn(),
    appendEvaluation: vi.fn().mockResolvedValue({ id: ids.evaluations }),
    projectEvaluation: vi.fn().mockResolvedValue(evaluated),
    findEvaluationOperation: vi.fn().mockResolvedValue(null),
  };
  const service = new EvaluationService(
    repo as unknown as EvaluationRepository,
    ops,
  );
  const command = evaluationCommandSchema.parse({
    ideaId: idea.id,
    expectedRevision: idea.revision,
    draft: assessment,
    applyToIdea: false,
  });
  return { m, ops, repo, service, command, evaluated };
}
describe("versioned potential scoring", () => {
  it("maps the full 1–5 scale to 0–100 and agrees with the existing default rubric", () => {
    for (const n of [1, 2, 3, 4, 5]) {
      const values = {
        impact: n,
        alignment: n,
        feasibility: n,
        reusability: n,
        timing: n,
      };
      expect(potential(values)).toBe((n - 1) * 25);
      expect(potential(values)).toBe(scoreFromRatings(values));
    }
    expect(potential(assessment.ratings)).toBe(68);
  });
  it("supports custom weights but rejects missing, invalid or unnormalized values", () => {
    expect(
      potential(assessment.ratings, {
        impact: 100,
        alignment: 0,
        feasibility: 0,
        reusability: 0,
        timing: 0,
      }),
    ).toBe(75);
    expect(() =>
      potential(assessment.ratings, { ...defaultWeights, impact: 31 }),
    ).toThrow();
    expect(() => potential({ ...assessment.ratings, timing: 6 })).toThrow();
    expect(() => potential({ ...assessment.ratings, impact: NaN })).toThrow();
    expect(() =>
      potential({ ...assessment.ratings, impact: null } as never),
    ).toThrow();
    expect(() =>
      potential(assessment.ratings, { ...defaultWeights, timing: -1 }),
    ).toThrow();
  });
  it("requires evidence and snapshots while keeping effort/readiness separate", () => {
    expect(
      evaluationDraftSchema.safeParse({
        ...assessment,
        evidence: { ...assessment.evidence, impact: "" },
      }).success,
    ).toBe(false);
    expect(
      evaluationDraftSchema.safeParse({ ...assessment, confidence: 1.1 })
        .success,
    ).toBe(false);
    expect(
      evaluationDraftSchema.safeParse({
        ...assessment,
        ratings: { ...assessment.ratings, timing: 2.5 },
      }).success,
    ).toBe(false);
    const changed = {
      ...assessment,
      effort: "1 month+" as const,
      readiness: "Discovery" as const,
    };
    expect(potential(changed.ratings, changed.weights)).toBe(
      potential(assessment.ratings, assessment.weights),
    );
  });
  it("rejects provider instructions and approval/active-score fields as untrusted output", () => {
    const result = {
      ...assessment,
      modelIdentifier: "synthetic-model-v1",
      promptVersion: "evaluation-v1",
      inputRevision: idea.revision,
    };
    expect(aiAssessmentSchema.safeParse(result).success).toBe(true);
    expect(
      aiAssessmentSchema.safeParse({ ...result, autoApprove: true }).success,
    ).toBe(false);
    expect(
      aiAssessmentSchema.safeParse({
        ...result,
        tools: [{ name: "delete_idea" }],
      }).success,
    ).toBe(false);
    expect(
      aiAssessmentSchema.safeParse({ ...result, modelIdentifier: "" }).success,
    ).toBe(false);
  });
  it("validates portable drafts without reviving approvals or canonical completion", () => {
    const file = {
      format: "idea-lab-evaluation",
      version: 1,
      ideaId: null,
      inputRevision: null,
      draft: assessment,
    };
    expect(decodeDraftFile(JSON.stringify(file)).draft).toEqual(assessment);
    expect(() =>
      decodeDraftFile(JSON.stringify({ ...file, approvalToken: "forged" })),
    ).toThrow();
    expect(() =>
      decodeDraftFile(JSON.stringify({ ...file, version: 2 })),
    ).toThrow();
    expect(() =>
      decodeDraftFile(JSON.stringify({ ...file, ideaId: idea.id })),
    ).toThrow();
    expect(() => decodeDraftFile("x".repeat(100001))).toThrow();
  });
});
describe("human-approved evaluation save", () => {
  it("prepares exact evidence without mutations and binds to the canonical target", async () => {
    const s = setup(),
      review = await s.service.prepare(s.command, "owner"),
      op = await s.ops.read(review.approvalToken, "owner");
    expect(s.repo.appendEvaluation).not.toHaveBeenCalled();
    expect(s.repo.projectEvaluation).not.toHaveBeenCalled();
    expect(op.target).toBe(idea.id);
    expect(op.action).toBe("evaluation-history");
    expect(
      review.changes.find((c) => c.field === "Active score")?.after,
    ).toMatch(/unchanged/);
    expect(
      review.changes.find((c) => c.field === "Potential impact")?.after,
    ).toContain(assessment.evidence.impact);
    s.m.close();
  });
  it("appends history without silently replacing a manually approved score, including replay", async () => {
    const s = setup(),
      r = await s.service.prepare(s.command, "owner");
    const saved = await s.service.execute(s.command, r.approvalToken, "owner");
    expect(saved.evaluationId).toBe(ids.evaluations);
    expect(s.repo.appendEvaluation).toHaveBeenCalledTimes(1);
    expect(s.repo.projectEvaluation).not.toHaveBeenCalled();
    expect(
      (await s.service.execute(s.command, r.approvalToken, "owner")).replayed,
    ).toBe(true);
    expect(s.repo.appendEvaluation).toHaveBeenCalledTimes(1);
    s.m.close();
  });
  it("requires both explicit replacement and a reason for active manual scores", async () => {
    const s = setup(),
      apply = { ...s.command, applyToIdea: true };
    await expect(s.service.prepare(apply, "owner")).rejects.toMatchObject({
      code: "MANUAL_SCORE_PROTECTED",
    });
    await expect(
      s.service.prepare({ ...apply, replaceManualScore: true }, "owner"),
    ).rejects.toMatchObject({ code: "MANUAL_SCORE_PROTECTED" });
    const c = {
        ...apply,
        replaceManualScore: true,
        overrideReason: "New prototype evidence changes feasibility.",
      },
      r = await s.service.prepare(c, "owner");
    await s.service.execute(c, r.approvalToken, "owner");
    expect(s.repo.projectEvaluation).toHaveBeenCalledTimes(1);
    s.m.close();
  });
  it("rejects stale approval and tampered scores without creating history", async () => {
    const s = setup(),
      r = await s.service.prepare(s.command, "owner");
    await expect(
      s.service.execute(
        {
          ...s.command,
          draft: {
            ...assessment,
            ratings: { ...assessment.ratings, impact: 5 },
          },
        },
        r.approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    s.repo.get.mockResolvedValue({ ...s.evaluated, revision: "changed" });
    await expect(
      s.service.execute(s.command, r.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    expect(s.repo.appendEvaluation).not.toHaveBeenCalled();
    s.m.close();
  });
  it("shares the idea lock with other update workflows", async () => {
    const s = setup(),
      r = await s.service.prepare(s.command, "owner"),
      hash = await digest("another update"),
      other = await s.ops.issue(
        "owner",
        hash,
        "update",
        idea.id,
        idea.revision,
      );
    await s.ops.claim(await s.ops.read(other.token, "owner"), hash);
    await expect(
      s.service.execute(s.command, r.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "SAVE_BUSY" });
    expect(s.repo.appendEvaluation).not.toHaveBeenCalled();
    s.m.close();
  });
  it("keeps partial history/projection failures locked until both effects can be verified", async () => {
    const s = setup(),
      c = {
        ...s.command,
        applyToIdea: true,
        replaceManualScore: true,
        overrideReason: "New evidence.",
      },
      r = await s.service.prepare(c, "owner"),
      op = await s.ops.read(r.approvalToken, "owner");
    s.repo.projectEvaluation.mockRejectedValue(
      new AppError("WRITE_UNCERTAIN", "unknown", 503, undefined, true),
    );
    await expect(
      s.service.execute(c, r.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    s.repo.findEvaluationOperation.mockResolvedValue({
      id: ids.evaluations,
    } as never);
    expect((await s.service.reconcile(op.id, "owner")).status).toBe(
      "uncertain",
    );
    s.repo.get.mockResolvedValue({
      ...s.evaluated,
      latestEvaluationId: ids.evaluations,
      revision: "created:seed;revision:" + op.id + "@now",
    });
    expect((await s.service.reconcile(op.id, "owner")).status).toBe("done");
    expect(s.repo.appendEvaluation).toHaveBeenCalledTimes(1);
    await expect(s.service.reconcile(op.id, "other")).rejects.toMatchObject({
      status: 403,
    });
    s.m.close();
  });
  it("rejects approvals whose action is not an evaluation save", async () => {
    const s = setup(),
      hash = await digest(JSON.stringify(s.command)),
      r = await s.ops.issue("owner", hash, "update", idea.id, idea.revision);
    await expect(
      s.service.execute(s.command, r.token, "owner"),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    s.m.close();
  });

  it("releases the lock on a read failure before any mutation is attempted", async () => {
    const s = setup(),
      r = await s.service.prepare(s.command, "owner");
    s.repo.preflight.mockRejectedValue(new Error("schema read failed"));
    await expect(
      s.service.execute(s.command, r.approvalToken, "owner"),
    ).rejects.toThrow("schema read failed");
    expect((await s.ops.read(r.approvalToken, "owner")).status).toBe("failed");
    expect(s.repo.appendEvaluation).not.toHaveBeenCalled();
    const another = await s.ops.issue(
      "owner",
      await digest("next"),
      "update",
      idea.id,
      idea.revision,
    );
    await expect(
      s.ops.claim(
        await s.ops.read(another.token, "owner"),
        await digest("next"),
      ),
    ).resolves.toBe(true);
    s.m.close();
  });
});
