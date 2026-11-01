import { describe, it, expect, vi, afterEach } from "vitest";
import { memoryDB, idea, input, ids } from "./fixtures";
import { ImportJobStore } from "../lib/imports/job-store";
import { ImportJobService } from "../lib/imports/job-service";
import { Operations } from "../lib/ideas/operations";
import { IdeaService } from "../lib/ideas/service";
import { NotionRepository } from "../lib/ideas/notion";
import { AppError } from "../lib/ideas/errors";
import {
  importSourceSchema,
  sourceKey,
  sourceRevision,
} from "../lib/imports/provenance";
const source = importSourceSchema.parse({
  system: "ChatGPT",
  conversationId: "synthetic-import-job",
  messageId: "selected-turn",
  locator: "synthetic:selected-turn",
  originalUrl: null,
  conversationDate: null,
  adapterVersion: "chatgpt-mapping-v1",
  role: "user",
  evidence: "Selected synthetic evidence, never a whole conversation.",
});
const command = { action: "create" as const, data: input, source };
async function setup() {
  const memory = memoryDB(),
    ops = new Operations(memory.db),
    store = new ImportJobStore(memory.db),
    itemId = crypto.randomUUID();
  let saved: typeof idea | null = null,
    provenance: {
      source: { id: string; ideaIds: string[] };
      revision: string;
      operation: string;
    } | null = null;
  const repo = {
    get: vi.fn(async () => {
      if (!saved) throw new AppError("NOT_FOUND", "Synthetic idea absent", 404);
      return saved;
    }),
    findOperation: vi.fn(async () => saved),
    extractionReviews: vi.fn(async () => []),
    importedSourceState: vi.fn(async () => provenance),
    importedSourceByKey: vi.fn(async () => provenance),
    write: vi.fn(
      async (
        _data: unknown,
        op: string,
        _actor?: string,
        _id?: string,
        _revision?: string,
        beforeWrite?: () => Promise<void>,
      ) => {
        await beforeWrite?.();
        saved = {
          ...idea,
          revision:
            "created:" + op + ";revision:" + op + "@2026-11-01T00:00:00.000Z",
        };
        return saved;
      },
    ),
    importSource: vi.fn(
      async (
        _idea: unknown,
        op: string,
        _source?: unknown,
        _ai?: unknown,
        _review?: unknown,
        beforeWrite?: () => Promise<void>,
      ) => {
        await beforeWrite?.();
        provenance = {
          source: { id: ids.source, ideaIds: [idea.id] },
          revision: await sourceRevision(source),
          operation: op,
        };
        return provenance.source;
      },
    ),
  };
  const service = new ImportJobService(
    store,
    repo as unknown as NotionRepository,
    ops,
  );
  const manifest = {
    requestKey: crypto.randomUUID(),
    items: [
      {
        id: itemId,
        sourceKey: await sourceKey(source),
        sourceRevision: await sourceRevision(source),
      },
    ],
  };
  const job = await store.create(manifest, "owner");
  return {
    memory,
    ops,
    store,
    repo,
    service,
    itemId,
    job,
    manifest,
    changeIdea: (patch: Partial<typeof idea>) => {
      saved = { ...saved!, ...patch };
    },
  };
}
afterEach(() => vi.restoreAllMocks());
describe("durable selected-import jobs", () => {
  it("stores only owner-bound metadata, makes creation idempotent and rejects manifest substitution", async () => {
    const s = await setup();
    try {
      expect((await s.store.create(s.manifest, "owner")).id).toBe(s.job.id);
      await expect(
        s.store.create(
          {
            ...s.manifest,
            items: [{ ...s.manifest.items[0], sourceRevision: "a".repeat(64) }],
          },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "IMPORT_REQUEST_CHANGED" });
      await expect(s.store.view(s.job.id, "other-owner")).rejects.toMatchObject(
        { code: "IMPORT_JOB_NOT_FOUND" },
      );
      const raw = JSON.stringify(
        (
          await s.memory.db
            .prepare("SELECT * FROM idea_lab_import_job_items")
            .all()
        ).results,
      );
      expect(raw).not.toContain(source.evidence);
      expect(raw).not.toContain(input.title);
      expect(s.repo.write).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("uses exact reviewed commands, prevents native bypass and confirms one canonical save on replay", async () => {
    const s = await setup();
    try {
      const receipt = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      await expect(
        new IdeaService(s.repo as unknown as NotionRepository, s.ops).execute(
          command,
          receipt.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      await expect(
        s.service.commit(
          s.job.id,
          s.itemId,
          "owner",
          { ...command, data: { ...input, title: "Substituted" } },
          receipt.approvalToken,
        ),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      const result = await s.service.commit(
        s.job.id,
        s.itemId,
        "owner",
        command,
        receipt.approvalToken,
      );
      expect(result.idea.id).toBe(ids.idea);
      expect((await s.store.view(s.job.id, "owner")).items[0].status).toBe(
        "done",
      );
      expect(
        (
          await s.service.commit(
            s.job.id,
            s.itemId,
            "owner",
            command,
            receipt.approvalToken,
          )
        ).replayed,
      ).toBe(true);
      expect(s.repo.write).toHaveBeenCalledTimes(1);
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("cancels pending approvals and requires a fresh review after resume", async () => {
    const s = await setup();
    try {
      const receipt = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      await s.store.control(s.job.id, "owner", "cancel");
      await expect(
        s.service.commit(
          s.job.id,
          s.itemId,
          "owner",
          command,
          receipt.approvalToken,
        ),
      ).rejects.toThrow();
      await s.store.control(s.job.id, "owner", "resume");
      await expect(
        s.service.commit(
          s.job.id,
          s.itemId,
          "owner",
          command,
          receipt.approvalToken,
        ),
      ).rejects.toThrow();
      const fresh = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      await s.service.commit(
        s.job.id,
        s.itemId,
        "owner",
        command,
        fresh.approvalToken,
      );
      expect(s.repo.write).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("serializes competing workers and blocks another item from the same stable source", async () => {
    const s = await setup();
    try {
      const receipt = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r)),
        write = s.repo.write.getMockImplementation()!;
      s.repo.write.mockImplementation(async (...args) => {
        await gate;
        return write(...args);
      });
      const first = s.service.commit(
        s.job.id,
        s.itemId,
        "owner",
        command,
        receipt.approvalToken,
      );
      await vi.waitFor(() => expect(s.repo.write).toHaveBeenCalledTimes(1));
      await expect(
        s.service.commit(
          s.job.id,
          s.itemId,
          "owner",
          command,
          receipt.approvalToken,
        ),
      ).rejects.toThrow();
      release();
      await first;
      expect(s.repo.write).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("recovers a definitively rejected source without recreating the saved idea", async () => {
    const s = await setup();
    try {
      const receipt = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      s.repo.importSource.mockRejectedValueOnce(
        new AppError("NOTION_ACCESS_DENIED", "Synthetic source rejection", 403),
      );
      await expect(
        s.service.commit(
          s.job.id,
          s.itemId,
          "owner",
          command,
          receipt.approvalToken,
        ),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect((await s.store.view(s.job.id, "owner")).items[0]).toMatchObject({
        status: "check",
        phase: "source_rejected",
        attempts: 1,
      });
      const recovery = await s.service.prepareRecovery(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      expect(recovery.changes.map((c) => c.field)).toEqual([
        "Existing idea",
        "Source provenance",
      ]);
      await s.service.recover(
        s.job.id,
        s.itemId,
        "owner",
        command,
        recovery.approvalToken,
      );
      expect(s.repo.write).toHaveBeenCalledTimes(1);
      expect(s.repo.importSource).toHaveBeenCalledTimes(2);
      expect((await s.store.view(s.job.id, "owner")).items[0].status).toBe(
        "done",
      );
    } finally {
      s.memory.close();
    }
  });
  it("never replays an ambiguously dispatched source and accepts only positive canonical completion", async () => {
    const s = await setup();
    try {
      const receipt = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      s.repo.importSource.mockImplementationOnce(
        async (_idea, _op, _source, _ai, _review, beforeWrite) => {
          await beforeWrite?.();
          throw new AppError(
            "WRITE_UNCERTAIN",
            "Synthetic lost source response",
            503,
            undefined,
            true,
          );
        },
      );
      await expect(
        s.service.commit(
          s.job.id,
          s.itemId,
          "owner",
          command,
          receipt.approvalToken,
        ),
      ).rejects.toThrow();
      await expect(
        s.service.prepareRecovery(s.job.id, s.itemId, "owner", command),
      ).rejects.toMatchObject({ code: "IMPORT_OUTCOME_AMBIGUOUS" });
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
      const op = await s.ops.read(receipt.approvalToken, "owner");
      s.repo.importedSourceByKey.mockResolvedValue({
        source: { id: ids.source, ideaIds: [ids.idea] },
        revision: await sourceRevision(source),
        operation: op.id,
      });
      expect(
        (await s.service.inspect(s.job.id, s.itemId, "owner")).items[0].status,
      ).toBe("done");
      expect(s.repo.write).toHaveBeenCalledTimes(1);
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("blocks recovery after an external edit and rejects changed source or restored draft content", async () => {
    const s = await setup();
    try {
      await expect(
        s.service.prepare(s.job.id, s.itemId, "owner", {
          ...command,
          source: { ...source, evidence: "Changed evidence" },
        }),
      ).rejects.toMatchObject({ code: "IMPORT_SOURCE_CHANGED" });
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command);
      s.repo.importSource.mockRejectedValueOnce(
        new AppError("NOTION_ACCESS_DENIED", "Synthetic", 403),
      );
      await expect(
        s.service.commit(s.job.id, s.itemId, "owner", command, r.approvalToken),
      ).rejects.toThrow();
      await expect(
        s.service.prepareRecovery(s.job.id, s.itemId, "owner", {
          ...command,
          data: { ...input, title: "Changed draft" },
        }),
      ).rejects.toMatchObject({ code: "IMPORT_REVIEW_CHANGED" });
      s.changeIdea({ revision: "external-edit" });
      await expect(
        s.service.prepareRecovery(s.job.id, s.itemId, "owner", command),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("fences a stopped worker and recovers a positively verified idea without duplicate writes", async () => {
    const s = await setup();
    try {
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command),
        write = s.repo.write.getMockImplementation()!;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      s.repo.write.mockImplementationOnce(async (...args) => {
        const saved = await write(...args);
        await gate;
        return saved;
      });
      const first = s.service.commit(
        s.job.id,
        s.itemId,
        "owner",
        command,
        r.approvalToken,
      );
      const settled = first.catch((error) => error);
      await vi.waitFor(() => expect(s.repo.write).toHaveBeenCalledTimes(1));
      await expect(
        s.service.prepareRecovery(s.job.id, s.itemId, "owner", command),
      ).rejects.toThrow();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
      const state = await s.service.inspect(s.job.id, s.itemId, "owner");
      expect(state.items[0]).toMatchObject({
        status: "check",
        phase: "idea_confirmed",
        recoverable: true,
      });
      const recovery = await s.service.prepareRecovery(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      await s.service.recover(
        s.job.id,
        s.itemId,
        "owner",
        command,
        recovery.approvalToken,
      );
      release();
      await settled;
      expect((await s.store.view(s.job.id, "owner")).items[0].status).toBe(
        "done",
      );
      expect(s.repo.write).toHaveBeenCalledTimes(1);
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
      expect((await s.ops.read(r.approvalToken, "owner")).status).toBe("done");
    } finally {
      s.memory.close();
    }
  });
  it("stops at the next provider boundary when cancelled during the idea write", async () => {
    const s = await setup();
    try {
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command),
        write = s.repo.write.getMockImplementation()!;
      s.repo.write.mockImplementationOnce(async (...args) => {
        const saved = await write(...args);
        await s.store.control(s.job.id, "owner", "cancel");
        return saved;
      });
      await expect(
        s.service.commit(s.job.id, s.itemId, "owner", command, r.approvalToken),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      expect(s.repo.write).toHaveBeenCalledTimes(1);
      expect((await s.store.view(s.job.id, "owner")).items[0]).toMatchObject({
        status: "check",
        phase: "idea_confirmed",
      });
      // The repository was entered for preflight but its mutation callback refused dispatch.
      expect(await s.repo.importedSourceState()).toBeNull();
      await s.store.control(s.job.id, "owner", "resume");
      const recovery = await s.service.prepareRecovery(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      await s.service.recover(
        s.job.id,
        s.itemId,
        "owner",
        command,
        recovery.approvalToken,
      );
      expect(s.repo.write).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("resumes a worker stopped before any provider dispatch only after a fresh exact review", async () => {
    const s = await setup();
    try {
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command),
        op = await s.ops.read(r.approvalToken, "owner");
      await s.store.claim(s.job.id, s.itemId, "owner", op.id, "review");
      await s.ops.claim(op, op.payload_hash);
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
      expect(
        (await s.service.inspect(s.job.id, s.itemId, "owner")).items[0],
      ).toMatchObject({ phase: "not_started", recoverable: true });
      const recovery = await s.service.prepareRecovery(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      expect(recovery.action).toBe("import-recover-create");
      expect(s.repo.write).not.toHaveBeenCalled();
      await s.service.recover(
        s.job.id,
        s.itemId,
        "owner",
        command,
        recovery.approvalToken,
      );
      expect(s.repo.write).toHaveBeenCalledTimes(1);
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("prevents an old worker from unlocking a new recovery while the source write is in flight", async () => {
    const s = await setup();
    try {
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command),
        write = s.repo.write.getMockImplementation()!,
        sourceWrite = s.repo.importSource.getMockImplementation()!;
      let releaseOld!: () => void, releaseSource!: () => void;
      const oldGate = new Promise<void>((resolve) => (releaseOld = resolve)),
        sourceGate = new Promise<void>((resolve) => (releaseSource = resolve));
      s.repo.write.mockImplementationOnce(async (...args) => {
        const saved = await write(...args);
        await oldGate;
        return saved;
      });
      const old = s.service
        .commit(s.job.id, s.itemId, "owner", command, r.approvalToken)
        .catch((error) => error);
      await vi.waitFor(() => expect(s.repo.write).toHaveBeenCalledTimes(1));
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
      await s.service.inspect(s.job.id, s.itemId, "owner");
      const review = await s.service.prepareRecovery(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      s.repo.importSource.mockImplementationOnce(async (...args) => {
        await args[5]?.();
        await sourceGate;
        return sourceWrite(...args);
      });
      const recovery = s.service.recover(
        s.job.id,
        s.itemId,
        "owner",
        command,
        review.approvalToken,
      );
      await vi.waitFor(() =>
        expect(s.repo.importSource).toHaveBeenCalledTimes(1),
      );
      releaseOld();
      await old;
      expect((await s.ops.read(r.approvalToken, "owner")).status).toBe(
        "running",
      );
      expect(
        (
          await s.memory.db
            .prepare("SELECT operation_id FROM idea_lab_operation_locks")
            .all()
        ).results,
      ).toHaveLength(1);
      releaseSource();
      await recovery;
      expect((await s.ops.read(r.approvalToken, "owner")).status).toBe("done");
      expect(s.repo.write).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("expires new writes but retains unresolved job metadata for reconciliation", async () => {
    const s = await setup();
    try {
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command);
      s.repo.importSource.mockImplementationOnce(
        async (_idea, _op, _source, _ai, _review, before) => {
          await before?.();
          throw new AppError(
            "WRITE_UNCERTAIN",
            "Synthetic lost response",
            503,
            undefined,
            true,
          );
        },
      );
      await expect(
        s.service.commit(s.job.id, s.itemId, "owner", command, r.approvalToken),
      ).rejects.toThrow();
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 32 * 86400000);
      expect(await s.store.list("owner")).toHaveLength(1);
      expect((await s.store.view(s.job.id, "owner")).expired).toBe(true);
      await expect(
        s.store.control(s.job.id, "owner", "resume"),
      ).rejects.toMatchObject({ code: "IMPORT_JOB_EXPIRED" });
      expect(
        (await s.service.inspect(s.job.id, s.itemId, "owner")).items[0].status,
      ).toBe("check");
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("honors a rejected source's retry delay even when the shared save reports an uncertain partial result", async () => {
    const s = await setup();
    try {
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command);
      s.repo.importSource.mockRejectedValueOnce(
        new AppError(
          "NOTION_RATE_LIMITED",
          "Synthetic source rate limit",
          503,
          120,
        ),
      );
      await expect(
        s.service.commit(s.job.id, s.itemId, "owner", command, r.approvalToken),
      ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
      await expect(
        s.service.prepareRecovery(s.job.id, s.itemId, "owner", command),
      ).rejects.toMatchObject({ code: "IMPORT_RETRY_LATER" });
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
      expect(
        (await s.service.prepareRecovery(s.job.id, s.itemId, "owner", command))
          .action,
      ).toBe("import-recover");
      expect(s.repo.importSource).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("restores a stopped, unclaimed item to fresh review and makes concurrent creation idempotent", async () => {
    const s = await setup();
    try {
      const concurrent = await Promise.all([
        s.store.create(s.manifest, "owner"),
        s.store.create(s.manifest, "owner"),
      ]);
      expect(new Set(concurrent.map((j) => j.id)).size).toBe(1);
      const r = await s.service.prepare(s.job.id, s.itemId, "owner", command),
        op = await s.ops.read(r.approvalToken, "owner");
      await s.store.claim(s.job.id, s.itemId, "owner", op.id, "review");
      vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120001);
      expect(
        (await s.service.inspect(s.job.id, s.itemId, "owner")).items[0],
      ).toMatchObject({ status: "failed", phase: "idea_rejected" });
      await expect(
        s.service.commit(s.job.id, s.itemId, "owner", command, r.approvalToken),
      ).rejects.toThrow();
      const fresh = await s.service.prepare(
        s.job.id,
        s.itemId,
        "owner",
        command,
      );
      await s.service.commit(
        s.job.id,
        s.itemId,
        "owner",
        command,
        fresh.approvalToken,
      );
      expect(s.repo.write).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("limits write attempts and respects retry time without automatic provider retries", async () => {
    const s = await setup();
    try {
      s.repo.write.mockRejectedValue(
        new AppError("NOTION_RATE_LIMITED", "Synthetic rate limit", 503, 60),
      );
      for (let n = 0; n < 3; n++) {
        const r = await s.service.prepare(s.job.id, s.itemId, "owner", command);
        await expect(
          s.service.commit(
            s.job.id,
            s.itemId,
            "owner",
            command,
            r.approvalToken,
          ),
        ).rejects.toThrow();
        await expect(
          s.service.prepare(s.job.id, s.itemId, "owner", command),
        ).rejects.toMatchObject({
          code: n === 2 ? "IMPORT_ATTEMPT_LIMIT" : "IMPORT_RETRY_LATER",
        });
        vi.spyOn(Date, "now").mockReturnValue(Date.now() + 180001);
      }
      expect(s.repo.write).toHaveBeenCalledTimes(3);
      expect(s.repo.importSource).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
});
