import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setupSemantic,
  embeddingConfig,
  indexCommand,
  queryCommand,
} from "./semantic-fixtures";
import { SnapshotService } from "../lib/intelligence/snapshot-service";
import { SnapshotCoordinator } from "../lib/intelligence/snapshot-coordinator";
import { embeddingProfileHash } from "../lib/intelligence/embedding-config";
import {
  snapshotPlanSchema,
  snapshotBatchSchema,
} from "../lib/intelligence/snapshot-model";
import { digest } from "../lib/ideas/operations";
import type { NotionRepository } from "../lib/ideas/notion";
import { idea } from "./fixtures";
function setup() {
  const s = setupSemantic();
  s.records.push({
    ...structuredClone(idea),
    id: "70000000-0000-4000-8000-000000000007",
    title: "Second synthetic idea",
  });
  const service = new SnapshotService(
      embeddingConfig,
      s.repository as unknown as NotionRepository,
      s.operations,
      s.cache,
      s.provider,
    ),
    coordinator = new SnapshotCoordinator(s.operations, s.cache);
  return { ...s, service, coordinator };
}
type Setup = ReturnType<typeof setup>;
const planCommand = snapshotPlanSchema.parse({
  scope: "all-current-canonical-ideas",
  fields: ["title", "summary"],
});
async function plan(s: Setup, actor = "owner") {
  const r = await s.service.preparePlan(planCommand, actor);
  const result = await s.service.plan(r.command, r.approvalToken, actor);
  return result.snapshotId!;
}
async function batch(
  s: Setup,
  id: string,
  ids = s.records.map((r) => r.id),
  actor = "owner",
) {
  const r = await s.service.prepareBatch(
    { snapshotId: id, ideaIds: ids },
    actor,
  );
  await s.service.batch(r.command, r.approvalToken, actor);
  return r;
}
async function activate(s: Setup, id: string, actor = "owner") {
  const r = await s.service.prepareActivation({ snapshotId: id }, actor);
  await s.service.activate(r.command, r.approvalToken, actor);
  return r;
}
async function active(s: Setup) {
  const id = await plan(s);
  await batch(s, id);
  await activate(s, id);
  return id;
}
async function query(s: Setup) {
  const r = await s.service.prepareQuery(queryCommand, "owner");
  return s.service.query(r.command, r.approvalToken, "owner");
}
afterEach(() => vi.restoreAllMocks());
describe("atomic Notion-derived semantic generations", () => {
  it("plans the entire canonical collection with metadata only and no model attempt", async () => {
    const s = setup();
    try {
      const before = structuredClone(s.records),
        review = await s.service.preparePlan(planCommand, "owner");
      expect(s.provider.embed).not.toHaveBeenCalled();
      expect((await s.coordinator.list("owner")).snapshots).toHaveLength(0);
      const result = await s.service.plan(
          review.command,
          review.approvalToken,
          "owner",
        ),
        snapshot = await s.cache.snapshots.read("owner", result.snapshotId!);
      expect(snapshot.records.map((r) => r.id)).toEqual(
        s.records.map((r) => r.id),
      );
      expect(snapshot.manifest_json).not.toContain(idea.title);
      expect(snapshot.manifest_json).not.toContain(idea.summary);
      expect(snapshot.manifest_json).not.toContain(idea.revision);
      expect(snapshot.records[0].revision).toBe(await digest(idea.revision));
      expect(
        await s.operations.countAIAttempts("owner", Date.now() - 3600000),
      ).toBe(0);
      expect(s.records).toEqual(before);
      expect((await s.coordinator.list("owner")).snapshots[0]).toMatchObject({
        total: 2,
        built: 0,
        complete: false,
        active: false,
      });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("keeps partial staging invisible, then atomically replaces search with a complete snapshot", async () => {
    const s = setup();
    try {
      const legacy = await s.service.prepareIndex(indexCommand, "owner");
      await s.service.index(legacy.command, legacy.approvalToken, "owner");
      const first = await plan(s);
      await batch(s, first, [s.records[0].id]);
      expect((await query(s)).matches).toHaveLength(1);
      expect(await s.cache.snapshots.reference("owner")).toBeNull();
      await expect(
        s.service.prepareActivation({ snapshotId: first }, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_INCOMPLETE" });
      await batch(s, first, [s.records[1].id]);
      await activate(s, first);
      expect((await query(s)).matches).toHaveLength(2);
      expect((await query(s)).snapshotId).toBe(first);
      const replacement = await plan(s);
      await batch(s, replacement, [s.records[0].id]);
      expect((await query(s)).snapshotId).toBe(first);
      await batch(s, replacement, [s.records[1].id]);
      const preview = await s.service.prepareActivation(
        { snapshotId: replacement },
        "owner",
      );
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        first,
      );
      const paid = s.provider.embed.mock.calls.length;
      await s.service.activate(preview.command, preview.approvalToken, "owner");
      expect(s.provider.embed).toHaveBeenCalledTimes(paid);
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        replacement,
      );
      expect((await query(s)).snapshotId).toBe(replacement);
      expect(s.records[0].scores).toEqual(idea.scores);
      await expect(
        s.service.prepareIndex(indexCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_ACTIVE" });
      await expect(
        s.coordinator.prepareDiscard({ snapshotId: replacement }, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_ACTIVE" });
    } finally {
      s.memory.close();
    }
  });
  it.each(["description", "new member", "deleted member", "superseded member"])(
    "refuses activation after %s changes without disturbing the old index",
    async (kind) => {
      const s = setup();
      try {
        const old = await active(s),
          next = await plan(s);
        await batch(s, next);
        const r = await s.service.prepareActivation(
          { snapshotId: next },
          "owner",
        );
        if (kind === "description") s.records[0].summary += " changed";
        if (kind === "new member")
          s.records.push({
            ...structuredClone(idea),
            id: "80000000-0000-4000-8000-000000000008",
          });
        if (kind === "deleted member") s.records.pop();
        if (kind === "superseded member")
          s.records[1].canonicalIdeaId = s.records[0].id;
        await expect(
          s.service.activate(r.command, r.approvalToken, "owner"),
        ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CHANGED" });
        expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
          old,
        );
      } finally {
        s.memory.close();
      }
    },
  );
  it("allows current score-only revisions while preserving the original input-version hash", async () => {
    const s = setup();
    try {
      const id = await plan(s);
      s.records[0].priorityScore = 91;
      s.records[0].scores.impact = 5;
      s.records[0].revision = "external score-only edit";
      await batch(s, id);
      await activate(s, id);
      const result = await query(s);
      expect(
        result.matches.find((r) => r.idea.id === idea.id)?.idea.priorityScore,
      ).toBe(91);
      const snapshot = await s.cache.snapshots.read("owner", id),
        rows = await s.cache.rawRows("owner", snapshot.cache_profile);
      expect(rows.find((r) => r.idea_id === idea.id)?.input_revision).toBe(
        await digest(idea.revision),
      );
    } finally {
      s.memory.close();
    }
  });
  it("supports an explicitly reviewed complete empty collection without a model call or legacy fallback", async () => {
    const s = setup();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      await s.service.index(r.command, r.approvalToken, "owner");
      s.records.length = 0;
      const id = await plan(s);
      await activate(s, id);
      expect((await s.coordinator.list("owner")).snapshots[0]).toMatchObject({
        total: 0,
        complete: true,
        active: true,
      });
      expect(
        await s.cache.rows(
          "owner",
          await embeddingProfileHash(embeddingConfig),
        ),
      ).toHaveLength(0);
      await expect(
        s.service.prepareQuery(queryCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_INDEX_EMPTY" });
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("rejects unreviewed scope, duplicate IDs, oversized collections and another owner's manifest", async () => {
    const s = setup();
    try {
      expect(() =>
        snapshotPlanSchema.parse({ ...planCommand, scope: "selected" }),
      ).toThrow();
      expect(() =>
        snapshotBatchSchema.parse({
          snapshotId: "a".repeat(64),
          ideaIds: [idea.id, idea.id],
        }),
      ).toThrow();
      const id = await plan(s);
      await expect(
        s.service.prepareBatch({ snapshotId: id, ideaIds: [idea.id] }, "other"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_NOT_FOUND" });
      s.records.length = 0;
      for (let n = 0; n < 1001; n++)
        s.records.push({
          ...structuredClone(idea),
          id: "90000000-0000-4000-8000-" + n.toString(16).padStart(12, "0"),
        });
      await expect(
        s.service.preparePlan(planCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CAPACITY" });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("rejects changed plan payload, stale manifest, provider context and expired consent before paid work", async () => {
    const s = setup();
    try {
      const r = await s.service.preparePlan(planCommand, "owner");
      await expect(
        s.service.plan(
          { ...planCommand, fields: ["title"] },
          r.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      s.records[0].summary += " changed";
      await expect(
        s.service.plan(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CHANGED" });
      const id = await plan(s),
        b = await s.service.prepareBatch(
          { snapshotId: id, ideaIds: [idea.id] },
          "owner",
        );
      const rotated = new SnapshotService(
        { ...embeddingConfig, key: "new synthetic key" },
        s.repository as unknown as NotionRepository,
        s.operations,
        s.cache,
        s.provider,
      );
      await expect(
        rotated.batch(b.command, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CHANGED" });
      await s.memory.db
        .prepare("UPDATE idea_lab_operations SET expires_at=? WHERE id=?")
        .bind(Date.now() - 1, await digest(b.approvalToken))
        .run();
      await expect(
        s.service.batch(b.command, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("never replays valid batch rows and refuses model version changes between batches", async () => {
    const s = setup();
    try {
      const id = await plan(s);
      await batch(s, id, [s.records[0].id]);
      await expect(
        s.service.prepareBatch(
          { snapshotId: id, ideaIds: [s.records[0].id] },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "SEMANTIC_INDEX_CURRENT" });
      const b = await s.service.prepareBatch(
        { snapshotId: id, ideaIds: [s.records[1].id] },
        "owner",
      );
      s.provider.embed.mockResolvedValueOnce({
        vectors: [[1, 0, 0]],
        model: "embedding-model-v2",
        tokens: 1,
      });
      await expect(
        s.service.batch(b.command, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_MODEL_CHANGED" });
      expect((await s.coordinator.list("owner")).snapshots[0]).toMatchObject({
        built: 1,
        complete: false,
      });
      expect(await s.cache.snapshots.reference("owner")).toBeNull();
    } finally {
      s.memory.close();
    }
  });
  it("rechecks selected descriptions after embedding and stores no batch vectors on change", async () => {
    const s = setup();
    try {
      const id = await plan(s),
        r = await s.service.prepareBatch(
          { snapshotId: id, ideaIds: [idea.id] },
          "owner",
        );
      s.provider.embed.mockImplementationOnce(async () => {
        s.records[0].summary += " during model call";
        return { vectors: [[1, 0, 0]], model: "embedding-model-v1", tokens: 1 };
      });
      await expect(
        s.service.batch(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CHANGED" });
      expect((await s.coordinator.list("owner")).snapshots[0].built).toBe(0);
    } finally {
      s.memory.close();
    }
  });
  it("refuses corrupted vectors/manifests and keeps the active pointer on a failed replacement", async () => {
    const s = setup();
    try {
      const old = await active(s),
        next = await plan(s);
      await batch(s, next);
      const snapshot = await s.cache.snapshots.read("owner", next);
      await s.memory.db
        .prepare(
          "UPDATE idea_lab_semantic_vectors SET vector='AAAA' WHERE owner_hash=? AND profile_hash=?",
        )
        .bind(await digest("owner"), snapshot.cache_profile)
        .run();
      await expect(
        s.service.prepareActivation({ snapshotId: next }, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_INCOMPLETE" });
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        old,
      );
      await s.memory.db
        .prepare(
          "UPDATE idea_lab_semantic_snapshots SET manifest_hash=? WHERE id=?",
        )
        .bind("f".repeat(64), next)
        .run();
      await expect(s.cache.snapshots.read("owner", next)).rejects.toMatchObject(
        { code: "SEMANTIC_SNAPSHOT_UNAVAILABLE" },
      );
    } finally {
      s.memory.close();
    }
  });
  it("does not silently fall back after the active snapshot expires", async () => {
    const s = setup();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      await s.service.index(r.command, r.approvalToken, "owner");
      await s.memory.db
        .prepare("UPDATE idea_lab_semantic_vectors SET expires_at=?")
        .bind(Date.now() + 7200000)
        .run();
      const id = await active(s),
        snapshot = await s.cache.snapshots.read("owner", id),
        paid = s.provider.embed.mock.calls.length;
      vi.spyOn(Date, "now").mockReturnValue(snapshot.expires_at + 1);
      await expect(
        s.service.prepareQuery(queryCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_UNAVAILABLE" });
      expect(
        await s.cache.rawRows(
          "owner",
          await embeddingProfileHash(embeddingConfig),
        ),
      ).toHaveLength(1);
      expect((await s.coordinator.list("owner")).activeUnavailable).toBe(true);
      expect(s.provider.embed).toHaveBeenCalledTimes(paid);
    } finally {
      s.memory.close();
    }
  });
  it("checks snapshot expiry again before returning query results", async () => {
    const s = setup();
    try {
      const id = await active(s),
        snapshot = await s.cache.snapshots.read("owner", id),
        r = await s.service.prepareQuery(queryCommand, "owner");
      s.provider.embed.mockImplementationOnce(async () => {
        vi.spyOn(Date, "now").mockReturnValue(snapshot.expires_at + 1);
        return { vectors: [[1, 0, 0]], model: "embedding-model-v1", tokens: 1 };
      });
      await expect(
        s.service.query(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_UNAVAILABLE" });
    } finally {
      s.memory.close();
    }
  });
});
describe("snapshot recovery, cancellation and transactional isolation", () => {
  it.each(["plan", "batch", "activate"])(
    "reconciles a lost %s completion without provider replay",
    async (kind) => {
      const s = setup();
      try {
        let id: string | undefined, receipt: any;
        if (kind === "plan")
          receipt = await s.service.preparePlan(planCommand, "owner");
        else {
          id = await plan(s);
          if (kind === "batch")
            receipt = await s.service.prepareBatch(
              { snapshotId: id, ideaIds: s.records.map((r) => r.id) },
              "owner",
            );
          else {
            await batch(s, id);
            receipt = await s.service.prepareActivation(
              { snapshotId: id },
              "owner",
            );
          }
        }
        const finish = vi
          .spyOn(s.operations, "finishRunning")
          .mockRejectedValue(new Error("Lost local completion"));
        const call =
          kind === "plan"
            ? s.service.plan(receipt.command, receipt.approvalToken, "owner")
            : kind === "batch"
              ? s.service.batch(receipt.command, receipt.approvalToken, "owner")
              : s.service.activate(
                  receipt.command,
                  receipt.approvalToken,
                  "owner",
                );
        await expect(call).rejects.toThrow();
        finish.mockRestore();
        const paid = s.provider.embed.mock.calls.length,
          op = await s.operations.read(receipt.approvalToken, "owner");
        expect(op.status).toBe("running");
        expect((await s.coordinator.reconcile(op.id, "owner")).status).toBe(
          "done",
        );
        expect(s.provider.embed).toHaveBeenCalledTimes(paid);
      } finally {
        s.memory.close();
      }
    },
  );
  it("preserves verified partial rows and only reviews remaining batch work", async () => {
    const s = setup();
    try {
      const id = await plan(s),
        r = await s.service.prepareBatch(
          { snapshotId: id, ideaIds: s.records.map((i) => i.id) },
          "owner",
        ),
        put = s.cache.put.bind(s.cache);
      vi.spyOn(s.cache, "put")
        .mockImplementationOnce(put)
        .mockRejectedValueOnce(new Error("Synthetic second row failure"));
      await expect(
        s.service.batch(r.command, r.approvalToken, "owner"),
      ).rejects.toThrow();
      const op = await s.operations.read(r.approvalToken, "owner");
      expect((await s.coordinator.reconcile(op.id, "owner")).status).toBe(
        "failed",
      );
      const remaining = await s.service.prepareBatch(
        { snapshotId: id, ideaIds: s.records.map((i) => i.id) },
        "owner",
      );
      expect(remaining.command.ideaIds).toEqual([s.records[1].id]);
      expect(await s.cache.snapshots.reference("owner")).toBeNull();
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("fences in-flight replacement writes after cancellation and preserves the old index", async () => {
    const s = setup();
    try {
      const old = await active(s),
        next = await plan(s),
        r = await s.service.prepareBatch(
          { snapshotId: next, ideaIds: s.records.map((r) => r.id) },
          "owner",
        );
      let release!: (v: {
          vectors: number[][];
          model: string;
          tokens: number;
        }) => void,
        enter!: () => void;
      const started = new Promise<void>((resolve) => (enter = resolve));
      s.provider.embed.mockImplementationOnce(() => {
        enter();
        return new Promise((resolve) => (release = resolve));
      });
      const pending = s.service.batch(r.command, r.approvalToken, "owner");
      await started;
      const queryReceipt = await s.service.prepareQuery(queryCommand, "owner");
      await expect(
        s.service.query(
          queryReceipt.command,
          queryReceipt.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      const op = await s.operations.read(r.approvalToken, "owner");
      await s.coordinator.cancel(op.id, "owner");
      release({
        vectors: [
          [1, 0, 0],
          [1, 0, 0],
        ],
        model: "embedding-model-v1",
        tokens: 2,
      });
      await expect(pending).rejects.toMatchObject({
        code: "SEMANTIC_CANCELLED",
      });
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        old,
      );
      expect(
        (await s.coordinator.list("owner")).snapshots.find((p) => p.id === next)
          ?.built,
      ).toBe(0);
      expect((await s.coordinator.reconcile(op.id, "owner")).status).toBe(
        "cancelled",
      );
    } finally {
      s.memory.close();
    }
  });
  it.each(["before", "after"])(
    "cancellation %s the pointer switch cannot produce a partial snapshot",
    async (when) => {
      const s = setup();
      try {
        const old = await active(s),
          next = await plan(s);
        await batch(s, next);
        const r = await s.service.prepareActivation(
            { snapshotId: next },
            "owner",
          ),
          op = await s.operations.read(r.approvalToken, "owner"),
          original = s.cache.snapshots.activate.bind(s.cache.snapshots);
        vi.spyOn(s.cache.snapshots, "activate").mockImplementationOnce(
          async (...args) => {
            if (when === "before") await s.coordinator.cancel(op.id, "owner");
            await original(...args);
            if (when === "after") await s.coordinator.cancel(op.id, "owner");
          },
        );
        await expect(
          s.service.activate(r.command, r.approvalToken, "owner"),
        ).rejects.toThrow();
        expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
          when === "before" ? old : next,
        );
        expect((await s.operations.read(r.approvalToken, "owner")).status).toBe(
          "cancelled",
        );
        expect((await s.coordinator.reconcile(op.id, "owner")).status).toBe(
          "cancelled",
        );
      } finally {
        s.memory.close();
      }
    },
  );
  it("rejects a superseded activation receipt after another complete pointer switch", async () => {
    const s = setup();
    try {
      await active(s);
      const a = await plan(s),
        b = await plan(s);
      await batch(s, a);
      await batch(s, b);
      const ra = await s.service.prepareActivation({ snapshotId: a }, "owner"),
        rb = await s.service.prepareActivation({ snapshotId: b }, "owner");
      await s.service.activate(rb.command, rb.approvalToken, "owner");
      await expect(
        s.service.activate(ra.command, ra.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CHANGED" });
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(b);
    } finally {
      s.memory.close();
    }
  });
  it("rolls back multi-table clearing on database failure and then clears atomically without model configuration", async () => {
    const s = setup();
    try {
      const old = await active(s),
        building = await plan(s);
      await batch(s, building, [idea.id]);
      const original = s.memory.db.batch!.bind(s.memory.db),
        before = await s.cache.fingerprint("owner"),
        r = await s.coordinator.prepareClear("owner");
      vi.spyOn(s.memory.db, "batch").mockImplementationOnce((statements) =>
        original([
          ...statements,
          s.memory.db.prepare("INSERT INTO nonexistent_test_table VALUES (1)"),
        ]),
      );
      await expect(
        s.coordinator.clear(r.approvalToken, "owner"),
      ).rejects.toThrow();
      expect((await s.cache.fingerprint("owner")).hash).toBe(before.hash);
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        old,
      );
      const fresh = await s.coordinator.prepareClear("owner");
      await s.coordinator.clear(fresh.approvalToken, "owner");
      expect((await s.cache.stats("owner")).total).toBe(0);
      expect(await s.coordinator.list("owner")).toMatchObject({
        snapshots: [],
        activeSnapshotId: null,
      });
      expect(s.records[0]).toEqual(idea);
    } finally {
      s.memory.close();
    }
  });
  it("discards only inactive owned snapshots, checks drift and reconciles lost deletion completion", async () => {
    const s = setup();
    try {
      const old = await active(s),
        next = await plan(s),
        review = await s.coordinator.prepareDiscard(
          { snapshotId: next },
          "owner",
        );
      await batch(s, next, [idea.id]);
      await expect(
        s.coordinator.discard(review.command, review.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_SEMANTIC_CACHE" });
      const r = await s.coordinator.prepareDiscard(
          { snapshotId: next },
          "owner",
        ),
        remove = s.cache.snapshots.discard.bind(s.cache.snapshots);
      vi.spyOn(s.cache.snapshots, "discard").mockImplementationOnce(
        async (...args) => {
          await remove(...args);
          throw new Error("Lost discard response");
        },
      );
      await expect(
        s.coordinator.discard(r.command, r.approvalToken, "owner"),
      ).rejects.toThrow();
      const op = await s.operations.read(r.approvalToken, "owner"),
        paid = s.provider.embed.mock.calls.length;
      expect((await s.coordinator.reconcile(op.id, "owner")).status).toBe(
        "done",
      );
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        old,
      );
      expect(s.provider.embed).toHaveBeenCalledTimes(paid);
      await expect(
        s.coordinator.prepareDiscard({ snapshotId: old }, "other"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_NOT_FOUND" });
    } finally {
      s.memory.close();
    }
  });
  it("bounds retained manifests and shares batch attempts with all other AI tasks", async () => {
    const s = setup();
    try {
      const id = await plan(s);
      await plan(s);
      await plan(s);
      await expect(
        s.service.preparePlan(planCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_CAPACITY" });
      const single = new SnapshotService(
          { ...embeddingConfig, requestsPerHour: 1 },
          s.repository as unknown as NotionRepository,
          s.operations,
          s.cache,
          s.provider,
        ),
        old = await s.operations.issue("owner", "x", "ai-evaluate", null, null);
      await s.operations.finish(old.id, "done");
      const r = await single.prepareBatch(
        { snapshotId: id, ideaIds: [idea.id] },
        "owner",
      );
      await expect(
        single.batch(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "AI_BUDGET_EXHAUSTED" });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("does not let a preapproved sparse index mutate search after full activation", async () => {
    const s = setup();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      const id = await active(s),
        paid = s.provider.embed.mock.calls.length;
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_SNAPSHOT_ACTIVE" });
      expect((await s.cache.snapshots.reference("owner"))?.snapshot_id).toBe(
        id,
      );
      expect(s.provider.embed).toHaveBeenCalledTimes(paid);
    } finally {
      s.memory.close();
    }
  });
});

it("reports newly added canonical records that are outside the active manifest", async () => {
  const s = setup();
  try {
    await active(s);
    s.records.push({
      ...structuredClone(idea),
      id: "80000000-0000-4000-8000-000000000008",
      title: "Newly added idea",
    });
    const result = await query(s);
    expect(result.matches).toHaveLength(2);
    expect(result.excluded.notIndexed).toBe(1);
  } finally {
    s.memory.close();
  }
});
