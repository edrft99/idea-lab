import { describe, it, expect, vi, afterEach } from "vitest";
import { setup } from "./proposal-fixtures";
import { AssistantCaptureService } from "../lib/assistant-capture/service";
import { AssistantCaptureStore } from "../lib/assistant-capture/store";
import { IdeaService } from "../lib/ideas/service";
import { digest } from "../lib/ideas/operations";
import {
  proposeCaptureSchema,
  updateCaptureSchema,
} from "../lib/assistant-capture/model";
import { input, ids, page, idea } from "./fixtures";
const command = proposeCaptureSchema.parse({
  captureId: "80000000-0000-4000-8000-000000000008",
  client: "Claude",
  data: input,
  evidence: "I want to build a reusable portable sensor workshop kit.",
});
function ready() {
  const s = setup(),
    store = new AssistantCaptureStore(s.memory.db, s.ops),
    service = new AssistantCaptureService(s.repo, s.ops, store, [
      "synthetic private key fixture",
    ]);
  return { ...s, store, capture: service };
}
afterEach(() => vi.restoreAllMocks());
describe("assistant capture human-approval boundary", () => {
  it.each(["Claude", "ChatGPT", "Claude Code", "Codex"] as const)(
    "stages selected %s evidence without a Notion write, then saves only after exact website approval",
    async (client) => {
      const s = ready();
      try {
        const proposal = await s.capture.propose(
          { ...command, client },
          "owner",
        );
        expect(proposal.status).toBe("pending");
        expect(s.writes()).toHaveLength(0);
        expect(proposal).not.toHaveProperty("approvalToken");
        const view = await s.capture.view(proposal.proposalId, "owner");
        expect(view.canApprove).toBe(true);
        if (!("command" in view)) throw new Error("Expected pending review");
        expect(view.command?.action).toBe("create");
        expect(
          view.changes?.find((c) => c.field === "Source provenance")?.after,
        ).toContain(client);
        await expect(
          s.capture.save(proposal.proposalId, "owner"),
        ).rejects.toMatchObject({ code: "HUMAN_APPROVAL_REQUIRED" });
        expect(s.writes()).toHaveLength(0);
        const saved = await s.capture.approveAndSave(
          proposal.proposalId,
          "owner",
        );
        expect(saved.status).toBe("done");
        expect(saved.canonicalUrl).toContain(saved.ideaId);
        expect(s.writes(ids.ideas)).toHaveLength(1);
        expect(s.writes(ids.sources)).toHaveLength(1);
        const source = [...s.rows.values()].find(
          (p) => p.parent.data_source_id === ids.sources,
        )!;
        expect(source.properties["Source System"].select.name).toBe(client);
        expect(JSON.stringify(source)).toContain(command.evidence);
        expect(
          (await s.store.read("owner", proposal.proposalId)).row.command_json,
        ).toBeNull();
        expect(
          (await s.capture.save(proposal.proposalId, "owner")).status,
        ).toBe("done");
        expect(s.writes(ids.ideas)).toHaveLength(1);
      } finally {
        s.memory.close();
      }
    },
  );
  it("binds client/capture ID to immutable data and reuses the same pending request", async () => {
    const s = ready();
    try {
      const a = await s.capture.propose(command, "owner"),
        b = await s.capture.propose(command, "owner");
      expect(a.proposalId).toBe(b.proposalId);
      await expect(
        s.capture.propose(
          { ...command, data: { ...command.data, title: "Changed request" } },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "CAPTURE_REQUEST_CHANGED" });
      expect(
        (
          (await s.capture.view(a.proposalId, "owner")) as {
            command?: { data: { title: string } };
          }
        ).command?.data.title,
      ).toBe(input.title);
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("requires owner scope and never accepts an assistant-created approval flag", async () => {
    const s = ready();
    try {
      const p = await s.capture.propose(command, "owner");
      expect(() =>
        proposeCaptureSchema.parse({ ...command, approved: true }),
      ).toThrow();
      await expect(s.capture.view(p.proposalId, "other")).rejects.toMatchObject(
        { code: "ASSISTANT_CAPTURE_NOT_FOUND" },
      );
      await expect(
        s.capture.approveAndSave(p.proposalId, "other"),
      ).rejects.toMatchObject({ code: "ASSISTANT_CAPTURE_NOT_FOUND" });
      const view = await s.capture.view(p.proposalId, "owner");
      if (!("command" in view)) throw new Error("Expected pending review");
      await expect(
        new IdeaService(s.repo, s.ops).executeAssistantApproved(
          view.command!,
          p.proposalId,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "HUMAN_APPROVAL_REQUIRED" });
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("rejects raw payload substitution against the original receipt", async () => {
    const s = ready();
    try {
      const p = await s.capture.propose(command, "owner"),
        { row } = await s.store.read("owner", p.proposalId),
        payload = JSON.parse(row.command_json!);
      payload.command.data.title = "Tampered title";
      await s.memory.db
        .prepare(
          "UPDATE idea_lab_assistant_captures SET command_json=? WHERE id=?",
        )
        .bind(JSON.stringify(payload), p.proposalId)
        .run();
      await expect(
        s.capture.approveAndSave(p.proposalId, "owner"),
      ).rejects.toMatchObject({ code: "ASSISTANT_CAPTURE_INVALID" });
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("rejects and clears drafts without canonical changes", async () => {
    const s = ready();
    try {
      const p = await s.capture.propose(command, "owner");
      expect((await s.capture.reject(p.proposalId, "owner")).status).toBe(
        "cancelled",
      );
      expect(
        (await s.store.read("owner", p.proposalId)).row.command_json,
      ).toBeNull();
      expect((await s.capture.save(p.proposalId, "owner")).status).toBe(
        "cancelled",
      );
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("expires server payloads and their consent before any save", async () => {
    const s = ready();
    try {
      const p = await s.capture.propose(command, "owner"),
        { row } = await s.store.read("owner", p.proposalId);
      vi.spyOn(Date, "now").mockReturnValue(row.expires_at + 1);
      expect((await s.capture.status(p.proposalId, "owner")).status).toBe(
        "expired",
      );
      expect(
        (await s.store.read("owner", p.proposalId)).row.command_json,
      ).toBeNull();
      await expect(
        s.capture.approveAndSave(p.proposalId, "owner"),
      ).rejects.toMatchObject({ code: "ASSISTANT_CAPTURE_EXPIRED" });
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("rechecks canonical revisions, preserves manual scores and writes no new source on an approved update", async () => {
    const s = ready();
    s.rows.set(ids.idea, page());
    try {
      const original = await s.repo.get(ids.idea),
        c = updateCaptureSchema.parse({
          captureId: command.captureId,
          client: "ChatGPT",
          id: ids.idea,
          expectedRevision: original.revision,
          data: { ...input, summary: "Updated selected summary" },
        }),
        p = await s.capture.update(c, "owner");
      expect(s.writes()).toHaveLength(0);
      await s.capture.approveAndSave(p.proposalId, "owner");
      const current = await s.repo.get(ids.idea);
      expect(current.summary).toBe(c.data.summary);
      expect(current.scores).toEqual(original.scores);
      expect(current.sourceIds).toEqual(original.sourceIds);
      expect(s.writes(ids.sources)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("blocks an update that became stale after preparation", async () => {
    const s = ready();
    s.rows.set(ids.idea, page());
    try {
      const current = await s.repo.get(ids.idea),
        p = await s.capture.update(
          updateCaptureSchema.parse({
            captureId: command.captureId,
            client: "Claude",
            id: ids.idea,
            expectedRevision: current.revision,
            data: { ...input, summary: "New summary" },
          }),
          "owner",
        );
      s.rows.get(ids.idea)!.last_edited_time = "2026-11-01T10:00:00Z";
      expect((await s.capture.view(p.proposalId, "owner")).canApprove).toBe(
        false,
      );
      await expect(
        s.capture.approveAndSave(p.proposalId, "owner"),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("keeps lost canonical replies uncertain and reconciles without another create", async () => {
    const s = ready();
    try {
      const p = await s.capture.propose(command, "owner");
      s.faults.lostCreate = ids.ideas;
      await expect(
        s.capture.approveAndSave(p.proposalId, "owner"),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect((await s.capture.save(p.proposalId, "owner")).status).toBe(
        "uncertain",
      );
      await s.capture.reconcile(p.proposalId, "owner");
      expect(s.writes(ids.ideas)).toHaveLength(1);
      expect(s.writes(ids.sources)).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("redacts only selected payloads and records unknown original source IDs explicitly", async () => {
    const s = ready();
    try {
      const p = await s.capture.propose(
          {
            ...command,
            evidence:
              "Selected idea synthetic private key fixture email fixture@example.test",
            data: {
              ...input,
              summary: "Selected synthetic private key fixture",
            },
          },
          "owner",
        ),
        view = await s.capture.view(p.proposalId, "owner");
      expect(JSON.stringify(view)).not.toContain(
        "synthetic private key fixture",
      );
      expect(JSON.stringify(view)).not.toContain("fixture@example.test");
      expect(JSON.stringify(view)).toContain("[REDACTED]");
      expect(JSON.stringify(view)).toContain("not supplied");
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
  it("limits active drafts per owner without writing canonical records", async () => {
    const s = ready();
    try {
      for (let n = 0; n < 20; n++)
        await s.capture.propose(
          {
            ...command,
            captureId:
              "90000000-0000-4000-8000-" + n.toString(16).padStart(12, "0"),
          },
          "owner",
        );
      await expect(
        s.capture.propose(
          { ...command, captureId: "a0000000-0000-4000-8000-000000000001" },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "ASSISTANT_CAPTURE_LIMIT" });
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  });
});
