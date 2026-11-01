import { describe, it, expect, vi } from "vitest";
import { Operations, digest } from "../lib/ideas/operations";
import { IdeaService } from "../lib/ideas/service";
import { AppError } from "../lib/ideas/errors";
import type { NotionRepository } from "../lib/ideas/notion";
import { input, idea, memoryDB, ids } from "./fixtures";
function setup() {
  const memory = memoryDB(),
    ops = new Operations(memory.db);
  const repo = {
    get: vi.fn().mockResolvedValue(idea),
    findOperation: vi.fn().mockResolvedValue(null),
    write: vi.fn().mockResolvedValue(idea),
    manualSource: vi.fn().mockResolvedValue({ id: ids.source }),
    hasManualSource: vi.fn().mockResolvedValue(true),
  };
  return {
    ...memory,
    ops,
    repo,
    service: new IdeaService(repo as unknown as NotionRepository, ops),
  };
}
const create = { action: "create" as const, data: input };
describe("approval ledger with real SQLite conditional writes", () => {
  it("preparing a review never mutates Notion and includes provenance", async () => {
    const s = setup();
    const approval = await s.service.prepare(create, "owner");
    expect(approval.changes.some((c) => c.field === "Source provenance")).toBe(
      true,
    );
    expect(s.repo.write).not.toHaveBeenCalled();
    s.close();
  });
  it("requires the same actor", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    await expect(
      s.service.execute(create, a.approvalToken, "someone-else"),
    ).rejects.toMatchObject({ status: 403 });
    expect(s.repo.write).not.toHaveBeenCalled();
    s.close();
  });
  it("rejects changed fields after approval", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    await expect(
      s.service.execute(
        { ...create, data: { ...input, title: "Different" } },
        a.approvalToken,
        "owner",
      ),
    ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
    expect(s.repo.write).not.toHaveBeenCalled();
    s.close();
  });
  it("creates once and returns the existing result for duplicate submission", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    await s.service.execute(create, a.approvalToken, "owner");
    expect(
      (await s.service.execute(create, a.approvalToken, "owner")).replayed,
    ).toBe(true);
    expect(s.repo.write).toHaveBeenCalledTimes(1);
    expect(s.repo.manualSource).toHaveBeenCalledTimes(1);
    s.close();
  });
  it("atomically grants only one concurrent operation claim", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner"),
      op = await s.ops.read(a.approvalToken, "owner");
    const outcomes = await Promise.allSettled([
      s.ops.claim(op, await digest(JSON.stringify(create))),
      s.ops.claim(op, await digest(JSON.stringify(create))),
    ]);
    expect(outcomes.filter((v) => v.status === "fulfilled")).toHaveLength(1);
    s.close();
  });
  it("rejects expired pending approval", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner"),
      op = await s.ops.read(a.approvalToken, "owner");
    await s.db
      .prepare("UPDATE idea_lab_operations SET expires_at=0 WHERE id=?")
      .bind(op.id)
      .run();
    await expect(
      s.service.execute(create, a.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    s.close();
  });
  it("rejects a stale update before issuing approval", async () => {
    const s = setup();
    await expect(
      s.service.prepare(
        {
          action: "update",
          id: idea.id,
          expectedRevision: "stale",
          data: input,
        },
        "owner",
      ),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    s.close();
  });
  it("rejects a revision changed between review and execution", async () => {
    const s = setup();
    const command = {
        action: "update" as const,
        id: idea.id,
        expectedRevision: idea.revision,
        data: { ...input, status: "Active" as const },
      },
      a = await s.service.prepare(command, "owner");
    s.repo.get.mockResolvedValue({ ...idea, revision: "changed" });
    await expect(
      s.service.execute(command, a.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "STALE_IDEA" });
    expect(s.repo.write).not.toHaveBeenCalled();
    s.close();
  });
  it("leaves uncertain writes locked and never replays them", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    s.repo.write.mockRejectedValue(
      new AppError("WRITE_UNCERTAIN", "uncertain", 503, undefined, true),
    );
    await expect(
      s.service.execute(create, a.approvalToken, "owner"),
    ).rejects.toMatchObject({ uncertain: true });
    await expect(
      s.service.execute(create, a.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    expect(s.repo.write).toHaveBeenCalledTimes(1);
    s.close();
  });
  it("does not mark partial provenance writes complete", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    s.repo.manualSource.mockRejectedValue(
      new AppError("NOTION_ACCESS_DENIED", "denied", 403),
    );
    await expect(
      s.service.execute(create, a.approvalToken, "owner"),
    ).rejects.toMatchObject({ uncertain: true });
    expect((await s.ops.read(a.approvalToken, "owner")).status).toBe(
      "uncertain",
    );
    s.close();
  });
  it("reconciles a completed create only when both idea and source are found", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    s.repo.write.mockRejectedValue(
      new AppError("WRITE_UNCERTAIN", "uncertain", 503, undefined, true),
    );
    await expect(
      s.service.execute(create, a.approvalToken, "owner"),
    ).rejects.toThrow();
    s.repo.findOperation.mockResolvedValue(idea);
    s.repo.hasManualSource.mockResolvedValue(false);
    expect((await s.service.reconcile(a.approvalToken, "owner")).status).toBe(
      "uncertain",
    );
    s.repo.hasManualSource.mockResolvedValue(true);
    expect((await s.service.reconcile(a.approvalToken, "owner")).status).toBe(
      "done",
    );
    expect(s.repo.write).toHaveBeenCalledTimes(1);
    s.close();
  });
  it("reuses a reconciled Notion result without another create", async () => {
    const s = setup(),
      a = await s.service.prepare(create, "owner");
    s.repo.findOperation.mockResolvedValue(idea);
    await s.service.execute(create, a.approvalToken, "owner");
    expect(s.repo.write).not.toHaveBeenCalled();
    s.close();
  });
});
