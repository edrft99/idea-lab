import { describe, it, expect, vi } from "vitest";
import { setup, command, source, text } from "./proposal-fixtures";
import { ids, input } from "./fixtures";
import { digest } from "../lib/ideas/operations";
import { IdeaService } from "../lib/ideas/service";
import {
  storeProposalSchema,
  proposalDecisionSchema,
} from "../lib/proposals/model";
const reason = "This selected idea is useful for the demo.";
async function decision(
  s: ReturnType<typeof setup>,
  kind: "Approve" | "Reject" = "Approve",
) {
  const row = await s.queued();
  const command = proposalDecisionSchema.parse({
    decision: kind,
    proposalId: row.id,
    proposalRevision: row.revision,
    reason,
    ...(kind === "Approve"
      ? { data: { ...input, title: "Reviewed sensor demonstration" } }
      : {}),
  });
  const receipt = await s.service.prepareDecision(command, "owner");
  return { row, command, receipt };
}
describe("authoritative extraction proposals", () => {
  it("stores selected evidence only; an explicit second approval creates the canonical idea and source", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      expect(s.writes(ids.reviews)).toHaveLength(1);
      expect(s.writes(ids.ideas)).toHaveLength(0);
      expect(s.writes(ids.sources)).toHaveLength(0);
      const before = structuredClone(s.rows.get(d.row.id));
      const saved = await s.service.decide(
        d.command,
        d.receipt.approvalToken,
        "owner",
      );
      expect(saved.idea?.title).toBe("Reviewed sensor demonstration");
      expect(saved.idea?.sources[0].summary).toBe(source.evidence);
      expect(s.writes(ids.ideas)).toHaveLength(1);
      expect(s.writes(ids.sources)).toHaveLength(1);
      expect(s.writes(ids.reviews)).toHaveLength(2);
      const resolved = await s.repo.proposal(d.row.id);
      expect(resolved.status).toBe("Approved");
      expect(resolved.canonicalIdeaId).toBe(ids.idea);
      for (const field of [
        "Proposal Payload",
        "Operation ID",
        "Reasoning",
        "Pair Key",
        "Candidate Revision",
      ])
        expect(s.rows.get(d.row.id).properties[field]).toEqual(
          before.properties[field],
        );
      expect(s.rows.get(d.row.id).children).toEqual(before.children);
      expect(
        (await s.service.decide(d.command, d.receipt.approvalToken, "owner"))
          .replayed,
      ).toBe(true);
      expect(s.writes(ids.ideas)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("records rejection memory and requires an explicit reason to reconsider", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Reject");
      await s.service.decide(d.command, d.receipt.approvalToken, "owner");
      expect((await s.repo.proposal(d.row.id)).status).toBe("Rejected");
      expect(s.writes(ids.ideas)).toHaveLength(0);
      expect(s.writes(ids.sources)).toHaveLength(0);
      await expect(
        s.service.prepareStore(command, "owner"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_REJECTED",
        reviewIds: [d.row.id],
      });
      expect(
        storeProposalSchema.safeParse({ ...command, reconsider: true }).success,
      ).toBe(false);
      const reconsider = {
        ...command,
        reconsider: true,
        reconsiderReason: "The demo requirements changed.",
      };
      const receipt = await s.service.prepareStore(reconsider, "owner");
      expect(receipt.changes.some((c) => c.field === "Prior rejection")).toBe(
        true,
      );
      await s.service.store(reconsider, receipt.approvalToken, "owner");
      expect((await s.repo.proposal(d.row.id)).status).toBe("Rejected");
      expect(await s.repo.history(d.row.snapshot.sourceKey)).toHaveLength(2);
    } finally {
      s.memory.close();
    }
  });
  it("detects a pending revision even when the Notion history query is delayed", async () => {
    const s = setup();
    try {
      const row = await s.queued();
      s.faults.hideHistory = true;
      await expect(
        s.service.prepareStore(command, "owner"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_ALREADY_QUEUED",
        reviewIds: [row.id],
      });
      expect(s.writes(ids.reviews)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("allows a separately reviewed changed source revision while preserving prior rejection", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Reject");
      await s.service.decide(d.command, d.receipt.approvalToken, "owner");
      const changed = {
        ...command,
        source: { ...source, evidence: "A revised selected suggestion." },
      };
      const receipt = await s.service.prepareStore(changed, "owner");
      await s.service.store(changed, receipt.approvalToken, "owner");
      expect(await s.repo.history(d.row.snapshot.sourceKey)).toHaveLength(2);
    } finally {
      s.memory.close();
    }
  });
  it("binds storage and decisions to actor, action, payload and current proposal revision", async () => {
    const s = setup();
    try {
      const a = await s.service.prepareStore(command, "owner");
      await expect(
        s.service.store(command, a.approvalToken, "intruder"),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        s.service.store(
          { ...command, note: "Substituted" },
          a.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      const saved = await s.service.store(command, a.approvalToken, "owner"),
        row = await s.repo.proposal(saved.reviewId!);
      const c = proposalDecisionSchema.parse({
        decision: "Approve",
        proposalId: row.id,
        proposalRevision: row.revision,
        data: input,
        reason,
      });
      await expect(
        s.service.decide(c, a.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      const receipt = await s.service.prepareDecision(c, "owner");
      await expect(
        s.service.decide(
          { ...c, reason: "Changed" },
          receipt.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      s.rows.get(row.id).properties.Reasoning.rich_text = [
        { text: { content: "External change" } },
      ];
      await expect(
        s.service.decide(c, receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_PROPOSAL" });
      expect(s.writes(ids.ideas)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("does not accept source substitution or unexpected decision fields", () => {
    expect(
      proposalDecisionSchema.safeParse({
        decision: "Reject",
        proposalId: ids.idea,
        proposalRevision: "a".repeat(64),
        reason,
        source,
      }).success,
    ).toBe(false);
  });
  it("reconciles a lost proposal-create reply without replaying creation", async () => {
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
      expect(
        (await s.service.store(command, a.approvalToken, "owner")).replayed,
      ).toBe(true);
    } finally {
      s.memory.close();
    }
  });
  it.each(["intent", "idea", "source"])(
    "never blindly replays a lost %s create response",
    async (phase) => {
      const s = setup();
      try {
        const d = await decision(s);
        s.faults.lostCreate =
          phase === "intent"
            ? ids.reviews
            : phase === "idea"
              ? ids.ideas
              : ids.sources;
        await expect(
          s.service.decide(d.command, d.receipt.approvalToken, "owner"),
        ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
        const state = await s.service.reconcileToken(
          d.receipt.approvalToken,
          "owner",
        );
        expect(state.status).toBe("uncertain");
        expect(state.canResume).toBe(phase === "source");
        const before = s.writes().length,
          op = await s.ops.read(d.receipt.approvalToken, "owner");
        if (phase === "source") {
          await s.service.resume(op.id, "owner");
          expect(s.writes().length).toBe(before + 1);
          expect(s.writes(ids.ideas)).toHaveLength(1);
          expect(s.writes(ids.sources)).toHaveLength(1);
        } else {
          await expect(s.service.resume(op.id, "owner")).rejects.toMatchObject({
            code: "RECONCILIATION_REQUIRED",
          });
          expect(s.writes()).toHaveLength(before);
        }
      } finally {
        s.memory.close();
      }
    },
  );
  it("resumes only the original queue update after canonical capture is positively verified", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      s.faults.denyClose = true;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      const state = await s.service.reconcileToken(
        d.receipt.approvalToken,
        "owner",
      );
      expect(state).toMatchObject({
        status: "uncertain",
        canResume: true,
        ideaId: ids.idea,
      });
      s.faults.denyClose = false;
      const op = await s.ops.read(d.receipt.approvalToken, "owner");
      await s.service.resume(op.id, "owner");
      expect(s.writes(ids.ideas)).toHaveLength(1);
      expect(s.writes(ids.sources)).toHaveLength(1);
      expect(s.writes(ids.reviews)).toHaveLength(2);
      expect((await s.repo.proposal(d.row.id)).status).toBe("Approved");
    } finally {
      s.memory.close();
    }
  });
  it("reconciles a lost final queue reply without another mutation", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      s.faults.lostClose = true;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      const before = s.writes().length;
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ status: "done", ideaId: ids.idea });
      expect(s.writes()).toHaveLength(before);
    } finally {
      s.memory.close();
    }
  });
  it("can finish a verified rejection intent without creating canonical records", async () => {
    const s = setup();
    try {
      const d = await decision(s, "Reject");
      s.faults.lostCreate = ids.reviews;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ canResume: true });
      await s.service.resume(
        (await s.ops.read(d.receipt.approvalToken, "owner")).id,
        "owner",
      );
      expect(s.writes(ids.ideas)).toHaveLength(0);
      expect(s.writes(ids.sources)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("holds locks after partial capture and rejects competing acceptance or rejection", async () => {
    const s = setup();
    try {
      const d = await decision(s),
        reject = proposalDecisionSchema.parse({
          decision: "Reject",
          proposalId: d.row.id,
          proposalRevision: d.row.revision,
          reason: "Not useful",
        });
      const b = await s.service.prepareDecision(reject, "owner");
      s.faults.denyCreate = ids.sources;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect(
        await s.service.reconcileToken(d.receipt.approvalToken, "owner"),
      ).toMatchObject({ canResume: false });
      await expect(
        s.service.decide(reject, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      expect(s.writes(ids.ideas)).toHaveLength(1);
    } finally {
      s.memory.close();
    }
  });
  it("refuses recovery if canonical content or original queue contents have changed", async () => {
    const s = setup();
    try {
      const d = await decision(s);
      s.faults.denyClose = true;
      await expect(
        s.service.decide(d.command, d.receipt.approvalToken, "owner"),
      ).rejects.toThrow();
      s.faults.denyClose = false;
      s.rows.get(d.row.id).properties.Reasoning.rich_text = [
        { text: { content: "Externally revised" } },
      ];
      const op = await s.ops.read(d.receipt.approvalToken, "owner");
      expect(await s.service.reconcile(op.id, "owner")).toMatchObject({
        canResume: false,
      });
      await expect(s.service.resume(op.id, "owner")).rejects.toMatchObject({
        code: "STALE_PROPOSAL",
      });
      s.rows.get(ids.idea).properties.Summary.rich_text = [
        { text: { content: "Changed canonical content" } },
      ];
      await expect(s.service.reconcile(op.id, "owner")).rejects.toMatchObject({
        code: "RECONCILIATION_REQUIRED",
      });
    } finally {
      s.memory.close();
    }
  });
  it("rejects tampered proposal and decision snapshots", async () => {
    const s = setup();
    try {
      const row = await s.queued(),
        raw = s.rows.get(row.id),
        snapshot = JSON.parse(text(raw.properties["Proposal Payload"]));
      snapshot.command.source.evidence = "Tampered";
      raw.properties["Proposal Payload"].rich_text = [
        { text: { content: JSON.stringify(snapshot) } },
      ];
      await expect(s.repo.proposal(row.id)).rejects.toMatchObject({
        code: "PROPOSAL_INVALID",
      });
    } finally {
      s.memory.close();
    }
  });
  it("blocks direct import capture before preparation and rechecks inside the save lock", async () => {
    const s = setup();
    try {
      const direct = new IdeaService(s.repo, s.ops),
        c = { action: "create" as const, data: input, source },
        receipt = await direct.prepare(c, "owner"),
        row = await s.queued();
      await expect(direct.prepare(c, "owner")).rejects.toMatchObject({
        code: "PROPOSAL_ALREADY_QUEUED",
        reviewIds: [row.id],
      });
      await expect(
        direct.execute(c, receipt.approvalToken, "owner"),
      ).rejects.toMatchObject({
        code: "PROPOSAL_ALREADY_QUEUED",
        reviewIds: [row.id],
      });
      expect(s.writes(ids.ideas)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
});

it("cannot bypass authoritative rejection through direct capture", async () => {
  const s = setup();
  try {
    const d = await decision(s, "Reject");
    await s.service.decide(d.command, d.receipt.approvalToken, "owner");
    const direct = new IdeaService(s.repo, s.ops);
    await expect(
      direct.prepare({ action: "create", data: input, source }, "owner"),
    ).rejects.toMatchObject({
      code: "PROPOSAL_ALREADY_QUEUED",
      reviewIds: [d.row.id],
    });
    expect(s.writes(ids.ideas)).toHaveLength(0);
  } finally {
    s.memory.close();
  }
});
it("refuses expired storage approvals before a Notion write", async () => {
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
