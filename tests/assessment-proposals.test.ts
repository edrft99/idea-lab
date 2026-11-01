import { describe, it, expect, vi } from "vitest";
import { setup as provider, text } from "./proposal-fixtures";
import { draft } from "./assessment-fixtures";
import { page, ids, config, idea } from "./fixtures";
import { AssessmentRepository } from "../lib/evaluations/proposal-repository";
import { AssessmentService } from "../lib/evaluations/proposal-service";
import { EvaluationService } from "../lib/evaluations/service";
import {
  assessmentStoreSchema,
  assessmentDecisionSchema,
} from "../lib/evaluations/proposal-model";
import { potential } from "../lib/evaluations/model";
const command = assessmentStoreSchema.parse({
  ideaId: ids.idea,
  inputRevision: idea.revision,
  draft,
  note: "Please review this evidence.",
});
function setup() {
  const s = provider();
  s.rows.set(ids.idea, page());
  const repo = new AssessmentRepository(config, s.fetcher),
    service = new AssessmentService(repo, s.ops);
  return { ...s, repo, service };
}
async function pending(s: ReturnType<typeof setup>) {
  const a = await s.service.prepareStore(command, "owner");
  const saved = await s.service.store(command, a.approvalToken, "owner");
  return s.repo.proposal(saved.reviewId!);
}
async function decision(
  s: ReturnType<typeof setup>,
  kind: "Approve" | "Reject" = "Approve",
  apply = false,
) {
  const row = await pending(s),
    c = assessmentDecisionSchema.parse({
      decision: kind,
      proposalId: row.id,
      proposalRevision: row.revision,
      reason: "The evidence supports this decision.",
      ...(kind === "Approve"
        ? {
            applyToIdea: apply,
            replaceManualScore: apply,
            overrideReason: apply
              ? "The prototype evidence supports a higher score."
              : "",
          }
        : {}),
    });
  return {
    row,
    command: c,
    receipt: await s.service.prepareDecision(c, "owner"),
  };
}
describe("saved evaluation proposal authority", () => {
  it.each([false, true])(
    "stores a Pending proposal before any evaluation write; acceptance applies active score=%s",
    async (apply) => {
      const s = setup();
      try {
        const original = structuredClone(s.rows.get(ids.idea)),
          d = await decision(s, "Approve", apply),
          proposalBefore = structuredClone(s.rows.get(d.row.id));
        expect(s.writes(ids.evaluations)).toHaveLength(0);
        expect(s.events.filter((e) => e.method === "PATCH")).toHaveLength(0);
        const saved = await s.service.decide(
          d.command,
          d.receipt.approvalToken,
          "owner",
        );
        expect(saved.evaluationId).toBeTruthy();
        expect(s.writes(ids.evaluations)).toHaveLength(1);
        expect((await s.repo.proposal(d.row.id)).status).toBe("Approved");
        const current = await s.repo.get(ids.idea);
        if (apply) {
          expect(current.priorityScore).toBe(
            potential(draft.ratings, draft.weights),
          );
          expect(current.scoreAuthority).toBe("manual-approved");
          expect(current.latestEvaluationId).toBe(saved.evaluationId);
        } else expect(s.rows.get(ids.idea)).toEqual(original);
        for (const name of [
          "Title",
          "Summary",
          "Estimated Effort",
          "Readiness",
          "Next Action",
          "Sources",
          "Status",
        ])
          expect(s.rows.get(ids.idea).properties[name]).toEqual(
            original.properties[name],
          );
        for (const name of [
          "Proposal Payload",
          "Reasoning",
          "Operation ID",
          "Candidate Revision",
          "Pair Key",
        ])
          expect(s.rows.get(d.row.id).properties[name]).toEqual(
            proposalBefore.properties[name],
          );
        expect(s.rows.get(d.row.id).children).toEqual(proposalBefore.children);
        expect(
          (await s.service.decide(d.command, d.receipt.approvalToken, "owner"))
            .replayed,
        ).toBe(true);
        expect(s.writes(ids.evaluations)).toHaveLength(1);
      } finally {
        s.memory.close();
      }
    },
  );
  it("protects manual scores unless replacement and reason are both explicitly reviewed", async () => {
    const s = setup();
    try {
      s.rows.get(ids.idea).properties["Score Authority"].select = {
        name: "manual-approved",
      };
      s.rows.get(ids.idea).properties["Priority Score"].number = 45;
      const row = await pending(s),
        base = {
          decision: "Approve" as const,
          proposalId: row.id,
          proposalRevision: row.revision,
          reason: "New evidence.",
          applyToIdea: true,
        };
      for (const consent of [
        { replaceManualScore: false, overrideReason: "Reason" },
        { replaceManualScore: true, overrideReason: "" },
      ]) {
        await expect(
          s.service.prepareDecision({ ...base, ...consent }, "owner"),
        ).rejects.toMatchObject({ code: "MANUAL_SCORE_PROTECTED" });
      }
      expect(s.writes(ids.evaluations)).toHaveLength(0);
      expect(s.rows.get(ids.idea).properties["Priority Score"].number).toBe(45);
    } finally {
      s.memory.close();
    }
  });
  it("rejects stale input on acceptance while allowing authoritative rejection", async () => {
    const s = setup();
    try {
      const row = await pending(s);
      s.rows.get(ids.idea).last_edited_time = "2026-11-01T00:00:00Z";
      const c = {
        proposalId: row.id,
        proposalRevision: row.revision,
        reason: "Input has changed.",
      };
      await expect(
        s.service.prepareDecision(
          {
            ...c,
            decision: "Approve",
            applyToIdea: false,
            replaceManualScore: false,
            overrideReason: "",
          },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      const reject = { ...c, decision: "Reject" as const },
        r = await s.service.prepareDecision(reject, "owner");
      await s.service.decide(reject, r.approvalToken, "owner");
      expect((await s.repo.proposal(row.id)).status).toBe("Rejected");
      expect(s.writes(ids.evaluations)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("preserves rejection memory and supports explicit reconsideration or material revision", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Reject");
      await s.service.decide(d.command, d.receipt.approvalToken, "owner");
      await expect(
        s.service.prepareStore(command, "owner"),
      ).rejects.toMatchObject({
        code: "ASSESSMENT_REJECTED",
        reviewIds: [d.row.id],
      });
      expect(
        assessmentStoreSchema.safeParse({ ...command, reconsider: true })
          .success,
      ).toBe(false);
      const reconsider = {
          ...command,
          reconsider: true,
          reconsiderReason: "The demo priority changed.",
        },
        a = await s.service.prepareStore(reconsider, "owner");
      await s.service.store(reconsider, a.approvalToken, "owner");
      expect((await s.repo.proposal(d.row.id)).status).toBe("Rejected");
      const changed = {
        ...command,
        draft: { ...draft, rationale: "Materially revised rationale." },
      };
      expect(await s.service.prepareStore(changed, "owner")).toHaveProperty(
        "approvalToken",
      );
    } finally {
      s.memory.close();
    }
  });
  it("deduplicates pending proposals when the Notion query index is delayed", async () => {
    const s = setup();
    try {
      const row = await pending(s);
      s.faults.hideHistory = true;
      await expect(
        s.service.prepareStore(command, "owner"),
      ).rejects.toMatchObject({
        code: "ASSESSMENT_ALREADY_QUEUED",
        reviewIds: [row.id],
      });
      expect(s.writes(ids.reviews)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("binds exact actor/action/payload/revision and prevents source or score injection into decisions", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "other"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        s.service.decide(
          { ...d.command, reason: "Substitution" },
          d.receipt.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      expect(
        assessmentDecisionSchema.safeParse({ ...d.command, draft }).success,
      ).toBe(false);
      s.rows.get(d.row.id).properties.Reasoning.rich_text = [
        { text: { content: "External queue edit" } },
      ];
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
      expect(s.writes(ids.evaluations)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("refuses expired receipts before mutation", async () => {
    const s = setup();
    try {
      const a = await s.service.prepareStore(command, "owner");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600000);
      await expect(
        s.service.store(command, a.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(s.writes()).toHaveLength(0);
    } finally {
      vi.restoreAllMocks();
      s.memory.close();
    }
  });
  it("reconciles a lost storage response without creating another proposal", async () => {
    const s = setup();
    try {
      const a = await s.service.prepareStore(command, "owner");
      s.faults.lostCreate = ids.reviews;
      await expect(
        s.service.store(command, a.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect(
        await s.service.reconcileToken(a.approvalToken, "owner"),
      ).toMatchObject({ status: "done", canResume: false });
      expect(s.writes(ids.reviews)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("never recreates evaluation history after losing a decision-intent response", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      s.faults.lostCreate = ids.reviews;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ status: "uncertain", canResume: false });
      await expect(
        s.service.resume(
          (await s.ops.read(d.receipt.approvalToken, "owner")).id,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
      expect(s.writes(ids.evaluations)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it.each([false, true])(
    "resumes a positively verified lost history response; active score=%s",
    async (apply) => {
      const s = setup();
      try {
        const d = await decision(s, "Approve", apply);
        s.faults.lostCreate = ids.evaluations;
        await expect(
          s.service.decide(d.command, d.receipt.approvalToken, "owner"),
        ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
        expect(
          await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
        ).toMatchObject({ status: "uncertain", canResume: true });
        const op = await s.ops.read(d.receipt.approvalToken, "owner");
        await s.service.resume(op.id, "owner");
        expect(s.writes(ids.evaluations)).toHaveLength(1);
        expect((await s.repo.proposal(d.row.id)).status).toBe("Approved");
        if (apply) expect((await s.repo.get(ids.idea)).priorityScore).toBe(68);
      } finally {
        s.memory.close();
      }
    },
  );
  it.each(["denied", "lost"])(
    "recovers a %s score projection without replaying evaluation creation",
    async (phase) => {
      const s = setup();
      try {
        const d = await decision(s, "Approve", true);
        s.faults.denyProjection = phase === "denied";
        s.faults.lostProjection = phase === "lost";
        await expect(
          s.service.decide(d.command, d.receipt.approvalToken, "owner"),
        ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
        expect(
          await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
        ).toMatchObject({ canResume: true });
        s.faults.denyProjection = false;
        await s.service.resume(
          (await s.ops.read(d.receipt.approvalToken, "owner")).id,
          "owner",
        );
        const projections = s.events.filter(
          (e) => e.method === "PATCH" && e.path === "pages/" + ids.idea,
        );
        expect(projections).toHaveLength(phase === "lost" ? 1 : 2);
        expect(s.writes(ids.evaluations)).toHaveLength(1);
        expect((await s.repo.get(ids.idea)).priorityScore).toBe(68);
      } finally {
        s.memory.close();
      }
    },
  );
  it("only closes the queue after a denied resolution; never overwrites the score again", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Approve", true);
      s.faults.denyClose = true;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toThrow();
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ canResume: true });
      s.faults.denyClose = false;
      await s.service.resume(
        (await s.ops.read(d.receipt.approvalToken, "owner")).id,
        "owner",
      );
      expect(s.writes(ids.evaluations)).toHaveLength(1);
      expect(
        s.events.filter(
          (e) => e.method === "PATCH" && e.path === "pages/" + ids.idea,
        ),
      ).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("reconciles a lost queue resolution response with no further mutation", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      s.faults.lostClose = true;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toThrow();
      const count = s.writes().length;
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ status: "done", canResume: false });
      expect(s.writes()).toHaveLength(count);
    } finally {
      s.memory.close();
    }
  });
  it("recovers rejection intent without evaluations or score updates", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Reject");
      s.faults.lostCreate = ids.reviews;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toThrow();
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ canResume: true });
      await s.service.resume(
        (await s.ops.read(d.receipt.approvalToken, "owner")).id,
        "owner",
      );
      expect(s.writes(ids.evaluations)).toHaveLength(0);
      expect(
        s.events.filter(
          (e) => e.method === "PATCH" && e.path === "pages/" + ids.idea,
        ),
      ).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("blocks competing idea edits and decisions while a partial assessment retains its locks", async () => {
    const s = setup();
    try {
      const d = await decision(s),
        reject = assessmentDecisionSchema.parse({
          decision: "Reject",
          proposalId: d.row.id,
          proposalRevision: d.row.revision,
          reason: "Competing decision",
        });
      const b = await s.service.prepareDecision(reject, "owner");
      s.faults.denyCreate = ids.evaluations;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toThrow();
      await expect(
        s.service.decide(reject, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ canResume: false });
    } finally {
      s.memory.close();
    }
  });
  it("refuses score recovery after an external idea change or altered history", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Approve", true);
      s.faults.denyProjection = true;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toThrow();
      s.rows.get(ids.idea).last_edited_time = "2026-11-01T00:00:00Z";
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ canResume: false });
      await expect(
        s.service.resume(
          (await s.ops.read(d.receipt.approvalToken, "owner")).id,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
      const evaluation = [...s.rows.values()].find(
        (r) => r.parent.data_source_id === ids.evaluations,
      );
      evaluation.properties["Weight Snapshot"].rich_text = [
        { text: { content: "Tampered" } },
      ];
      await expect(
        s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    } finally {
      s.memory.close();
    }
  });
  it("prevents direct evaluation save from bypassing pending and rejected assessment review", async () => {
    const s = setup();
    try {
      const direct = new EvaluationService(s.repo, s.ops),
        c = {
          ideaId: ids.idea,
          expectedRevision: idea.revision,
          draft,
          applyToIdea: false,
          replaceManualScore: false,
          overrideReason: "",
        };
      const a = await direct.prepare(c, "owner"),
        d = await decision(s, "Reject");
      await expect(direct.prepare(c, "owner")).rejects.toMatchObject({
        code: "ASSESSMENT_ALREADY_QUEUED",
      });
      await expect(
        direct.execute(c, a.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "ASSESSMENT_ALREADY_QUEUED" });
      await s.service.decide(d.command, d.receipt.approvalToken, "owner");
      await expect(direct.prepare(c, "owner")).rejects.toMatchObject({
        code: "ASSESSMENT_ALREADY_QUEUED",
      });
      expect(s.writes(ids.evaluations)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
});

it("does not confirm an externally altered decision reason after a lost resolution reply", async () => {
  const s = setup();
  try {
    const d = await decision(s, "Reject");
    s.faults.lostClose = true;
    await expect(
      s.service.decide(d.command, d.receipt.approvalToken, "owner"),
    ).rejects.toThrow();
    const row = s.rows.get(d.row.id),
      resolution = JSON.parse(text(row.properties["Reviewer Decision"]));
    resolution.reason = "External replacement reason";
    row.properties["Reviewer Decision"].rich_text = [
      { text: { content: JSON.stringify(resolution) } },
    ];
    expect(
      await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
    ).toMatchObject({ status: "uncertain", canResume: false });
  } finally {
    s.memory.close();
  }
});
