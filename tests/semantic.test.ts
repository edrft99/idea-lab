import { describe, it, expect, vi, afterEach } from "vitest";
import {
  setupSemantic,
  indexCommand,
  queryCommand,
  embeddingConfig,
} from "./semantic-fixtures";
import {
  SemanticService,
  SemanticCoordinator,
} from "../lib/intelligence/semantic-service";
import {
  embeddingProfileHash,
  checkedEmbeddingConfig,
} from "../lib/intelligence/embedding-config";
import {
  semanticInput,
  fieldsSchema,
  indexCommandSchema,
  queryCommandSchema,
  clipUTF8,
  cosine,
  unitVector,
} from "../lib/intelligence/semantic-model";
import { cacheLock } from "../lib/intelligence/semantic-cache";
import { digest } from "../lib/ideas/operations";
import { idea } from "./fixtures";
import type { NotionRepository } from "../lib/ideas/notion";
afterEach(() => vi.restoreAllMocks());
async function indexed(s: ReturnType<typeof setupSemantic>) {
  const r = await s.service.prepareIndex(indexCommand, "owner");
  await s.service.index(r.command, r.approvalToken, "owner");
  return r;
}
async function search(s: ReturnType<typeof setupSemantic>) {
  const r = await s.service.prepareQuery(queryCommand, "owner");
  return s.service.query(r.command, r.approvalToken, "owner");
}
describe("semantic projection and vector compatibility", () => {
  it("selects only description fields, redacts before clipping, and hashes hidden tails", async () => {
    const a = { ...idea, summary: "😀".repeat(200) + "secret-fixture-A" };
    const b = { ...a, summary: "😀".repeat(200) + "secret-fixture-B" };
    const projected = await semanticInput(a, ["summary"], ["secret-fixture-A"]);
    expect(projected.input).not.toContain("secret-fixture-A");
    expect(
      new TextEncoder().encode(JSON.parse(projected.input).summary).length,
    ).toBe(760);
    expect(projected.hash).not.toBe((await semanticInput(b, ["summary"])).hash);
    expect(JSON.parse((await semanticInput(idea, ["title"])).input)).toEqual({
      title: idea.title,
    });
    expect(clipUTF8("😀x", 3)).toBe("");
    expect(fieldsSchema.parse(["summary", "title"])).toEqual([
      "title",
      "summary",
    ]);
    expect(() => fieldsSchema.parse(["scores"])).toThrow();
    expect(() => fieldsSchema.parse(["title", "title"])).toThrow();
    expect(() =>
      indexCommandSchema.parse({
        ...indexCommand,
        records: [...indexCommand.records, ...indexCommand.records],
      }),
    ).toThrow();
    expect(() =>
      queryCommandSchema.parse({
        ...queryCommand,
        filters: { url: "https://outside.test" },
      }),
    ).toThrow();
  });
  it("normalizes finite nonzero compatible vectors", () => {
    expect(unitVector([3, 4, 0], 3)).toEqual([0.6, 0.8, 0]);
    expect(cosine(unitVector([3, 4, 0], 3), [0.6, 0.8, 0])).toBeCloseTo(1);
    for (const v of [
      [0, 0, 0],
      [NaN, 0, 1],
      [Infinity, 0, 1],
      [1, 2],
    ])
      expect(() => unitVector(v, 3)).toThrow();
    expect(() => cosine([1], [1, 0])).toThrow();
  });
  it("separates version and dimensions while rejecting unprotected destinations", async () => {
    expect(
      await embeddingProfileHash({ ...embeddingConfig, versionLabel: "v2" }),
    ).not.toBe(await embeddingProfileHash(embeddingConfig));
    expect(
      await embeddingProfileHash({
        ...embeddingConfig,
        key: "rotated-synthetic-key",
      }),
    ).toBe(await embeddingProfileHash(embeddingConfig));
    for (const c of [
      { endpoint: "http://synthetic.openai.azure.com/" },
      { endpoint: "https://outside.test/" },
      { dimensions: 0 },
      { cacheSeconds: 604801 },
      { versionLabel: "" },
    ])
      expect(() =>
        checkedEmbeddingConfig({ ...embeddingConfig, ...c }),
      ).toThrow();
  });
});
describe("Notion-authoritative derived semantic cache", () => {
  it("previews without a model call, indexes exact selected excerpts and returns current canonical links", async () => {
    const s = setupSemantic();
    try {
      const original = structuredClone(s.records),
        r = await s.service.prepareIndex(indexCommand, "owner");
      expect(s.provider.embed).not.toHaveBeenCalled();
      expect(r.changes[0].after).toContain(
        embeddingConfig.endpoint + "embeddings",
      );
      await s.service.index(r.command, r.approvalToken, "owner");
      expect(s.provider.embed).toHaveBeenCalledWith(
        [JSON.stringify({ title: idea.title, summary: idea.summary })],
        undefined,
      );
      const rows = await s.cache.rows(
        "owner",
        await embeddingProfileHash(embeddingConfig),
      );
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain(idea.title);
      expect(JSON.stringify(rows)).not.toContain(idea.summary);
      expect(JSON.stringify(rows)).not.toContain("priorityScore");
      expect((await s.cache.checked(rows[0])).values[0]).toBeCloseTo(0.6, 5);
      expect(
        await s.cache.rows(
          "other",
          await embeddingProfileHash(embeddingConfig),
        ),
      ).toHaveLength(0);
      const result = await search(s);
      expect(result.matches[0].idea.url).toBe(idea.url);
      expect(result.matches[0].similarity).toBeCloseTo(1);
      expect(s.records).toEqual(original);
      expect(s.provider.embed.mock.calls[1][0]).toEqual([queryCommand.query]);
      expect(await s.operations.recent("owner")).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ action: "semantic-query", status: "done" }),
        ]),
      );
      expect(JSON.stringify(await s.operations.recent("owner"))).not.toContain(
        queryCommand.query,
      );
    } finally {
      s.memory.close();
    }
  });
  it("skips current vectors and requires explicit regeneration", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      await expect(
        s.service.prepareIndex(indexCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_INDEX_CURRENT" });
      const r = await s.service.prepareIndex(
        { ...indexCommand, refresh: true },
        "owner",
      );
      await s.service.index(r.command, r.approvalToken, "owner");
      expect(s.provider.embed).toHaveBeenCalledTimes(2);
    } finally {
      s.memory.close();
    }
  });
  it.each(["changed", "deleted", "superseded", "tampered"])(
    "excludes %s canonical/cache inputs",
    async (kind) => {
      const s = setupSemantic();
      try {
        await indexed(s);
        if (kind === "changed") s.records[0].summary += " changed";
        if (kind === "deleted") s.records.length = 0;
        if (kind === "superseded")
          s.records[0].canonicalIdeaId = "70000000-0000-4000-8000-000000000007";
        if (kind === "tampered")
          await s.memory.db
            .prepare("UPDATE idea_lab_semantic_vectors SET vector='AAAA'")
            .run();
        const result = await search(s);
        expect(result.matches).toHaveLength(0);
        expect(Object.values(result.excluded).reduce((a, b) => a + b, 0)).toBe(
          1,
        );
      } finally {
        s.memory.close();
      }
    },
  );
  it("applies current filters before ranking, and does not treat score edits as description changes", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      s.records[0].priorityScore = 87;
      s.records[0].scores.impact = 5;
      expect((await search(s)).matches).toHaveLength(1);
      s.repository.list.mockResolvedValueOnce([]);
      const r = await search(s);
      expect(r.matches).toHaveLength(0);
      expect(s.repository.list).toHaveBeenLastCalledWith({
        ...queryCommand.filters,
        sort: "title",
      });
    } finally {
      s.memory.close();
    }
  });
  it("refuses model mismatch and profile changes", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      s.provider.embed.mockResolvedValueOnce({
        vectors: [[1, 0, 0]],
        model: "embedding-model-v2",
        tokens: 1,
      });
      await expect(search(s)).rejects.toMatchObject({
        code: "SEMANTIC_MODEL_CHANGED",
      });
      const other = new SemanticService(
        { ...embeddingConfig, versionLabel: "v2" },
        s.repository as unknown as NotionRepository,
        s.operations,
        s.cache,
        s.provider,
      );
      await expect(
        other.prepareQuery(queryCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_INDEX_EMPTY" });
    } finally {
      s.memory.close();
    }
  });
  it("expires derived vectors and cannot search an empty index", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      await s.memory.db
        .prepare("UPDATE idea_lab_semantic_vectors SET expires_at=?")
        .bind(Date.now() - 1)
        .run();
      await expect(
        s.service.prepareQuery(queryCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_INDEX_EMPTY" });
      expect((await s.cache.stats("owner")).total).toBe(0);
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("rejects stale or superseded selection before transmission", async () => {
    const s = setupSemantic();
    try {
      s.records[0].revision = "changed";
      await expect(
        s.service.prepareIndex(indexCommand, "owner"),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      s.records[0].revision = idea.revision;
      s.records[0].canonicalIdeaId = "70000000-0000-4000-8000-000000000007";
      await expect(
        s.service.prepareIndex(indexCommand, "owner"),
      ).rejects.toMatchObject({ code: "SUPERSEDED_IDEA" });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("rechecks all original fields after the model and stores nothing on a stale result", async () => {
    const s = setupSemantic();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      s.provider.embed.mockImplementationOnce(async () => {
        s.records[0].summary += " hidden edit";
        return { vectors: [[1, 0, 0]], model: "embedding-model-v1", tokens: 1 };
      });
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      expect((await s.cache.stats("owner")).total).toBe(0);
    } finally {
      s.memory.close();
    }
  });
  it("binds actor, fields, revision, credential context and expiry; never retries completed requests", async () => {
    const s = setupSemantic();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      await expect(
        s.service.index(r.command, r.approvalToken, "other"),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      await expect(
        s.service.index(
          { ...r.command, fields: ["title"] },
          r.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      const rotated = new SemanticService(
        { ...embeddingConfig, key: "changed-synthetic-key" },
        s.repository as unknown as NotionRepository,
        s.operations,
        s.cache,
        s.provider,
      );
      await expect(
        rotated.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      await s.service.index(r.command, r.approvalToken, "owner");
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_REQUEST_USED" });
      const second = await s.service.prepareIndex(
        { ...indexCommand, refresh: true },
        "owner",
      );
      await s.memory.db
        .prepare("UPDATE idea_lab_operations SET expires_at=? WHERE id=?")
        .bind(Date.now() - 1, await digest(second.approvalToken))
        .run();
      await expect(
        s.service.index(second.command, second.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("stops a second preapproved batch when another request already indexed its input", async () => {
    const s = setupSemantic();
    try {
      const a = await s.service.prepareIndex(indexCommand, "owner"),
        b = await s.service.prepareIndex(indexCommand, "owner");
      await s.service.index(a.command, a.approvalToken, "owner");
      await expect(
        s.service.index(b.command, b.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_INDEX_CURRENT" });
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("shares the owner AI attempt budget with extraction and assessment", async () => {
    const s = setupSemantic({ requestsPerHour: 1 });
    try {
      const old = await s.operations.issue(
        "owner",
        "x",
        "ai-extract",
        null,
        null,
      );
      await s.operations.finish(old.id, "done", "hash");
      const r = await s.service.prepareIndex(indexCommand, "owner");
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "AI_BUDGET_EXHAUSTED" });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("rejects malformed replacement-provider vectors before cache writes", async () => {
    const s = setupSemantic();
    try {
      s.provider.embed.mockResolvedValueOnce({
        vectors: [[0, 0, 0]],
        model: "embedding-model-v1",
        tokens: 1,
      });
      const r = await s.service.prepareIndex(indexCommand, "owner");
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toThrow();
      expect((await s.cache.stats("owner")).total).toBe(0);
    } finally {
      s.memory.close();
    }
  });
});
describe("semantic cancellation and verified recovery", () => {
  it("fences late in-flight writes after cancellation and never reopens cancelled operations", async () => {
    const s = setupSemantic();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      let release!: (v: {
        vectors: number[][];
        model: string;
        tokens: number;
      }) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      s.provider.embed.mockImplementationOnce(() => {
        entered();
        return new Promise((resolve) => (release = resolve));
      });
      const pending = s.service.index(r.command, r.approvalToken, "owner");
      await started;
      const op = await s.operations.read(r.approvalToken, "owner");
      expect((await s.service.cancel(op.id, "owner")).status).toBe("cancelled");
      release({ vectors: [[1, 0, 0]], model: "embedding-model-v1", tokens: 1 });
      await expect(pending).rejects.toMatchObject({
        code: "SEMANTIC_CANCELLED",
      });
      expect((await s.cache.stats("owner")).total).toBe(0);
      expect((await s.service.reconcile(op.id, "owner")).status).toBe(
        "cancelled",
      );
      expect(await s.operations.confirmSemanticIndex(op.id, "ignored")).toBe(
        false,
      );
      expect((await s.operations.read(r.approvalToken, "owner")).status).toBe(
        "cancelled",
      );
    } finally {
      s.memory.close();
    }
  });
  it("reconciles a lost completion from a complete cache manifest without a second model request", async () => {
    const s = setupSemantic();
    try {
      const r = await s.service.prepareIndex(indexCommand, "owner");
      const finish = vi
        .spyOn(s.operations, "finishRunning")
        .mockRejectedValue(new Error("Lost local completion"));
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toThrow();
      finish.mockRestore();
      const op = await s.operations.read(r.approvalToken, "owner");
      expect(op.status).toBe("running");
      expect((await s.service.reconcile(op.id, "owner")).status).toBe("done");
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
      expect(
        (await s.operations.read(r.approvalToken, "owner")).result_id,
      ).toBe(JSON.parse(op.expected_revision!).manifest);
    } finally {
      s.memory.close();
    }
  });
  it("keeps partial batches explicit and cancellation allows a reviewed rebuild", async () => {
    const s = setupSemantic();
    try {
      s.records.push({
        ...structuredClone(idea),
        id: "70000000-0000-4000-8000-000000000007",
        title: "Second synthetic idea",
      });
      const command = {
          ...indexCommand,
          records: s.records.map((r) => ({
            id: r.id,
            expectedRevision: r.revision,
          })),
        },
        r = await s.service.prepareIndex(command, "owner");
      const original = s.cache.put.bind(s.cache);
      vi.spyOn(s.cache, "put")
        .mockImplementationOnce(original)
        .mockRejectedValueOnce(new Error("Synthetic storage failure"));
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toThrow();
      expect((await s.cache.stats("owner")).total).toBe(1);
      const op = await s.operations.read(r.approvalToken, "owner");
      expect((await s.service.reconcile(op.id, "owner")).status).toBe("failed");
      const remaining = await s.service.prepareIndex(command, "owner");
      expect(remaining.command.records).toHaveLength(1);
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("clears only reviewed owner vectors without provider configuration and refuses cache drift", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      const coordinator = new SemanticCoordinator(s.operations, s.cache),
        r = await coordinator.prepareClear("owner");
      await s.memory.db
        .prepare("UPDATE idea_lab_semantic_vectors SET updated_at=updated_at+1")
        .run();
      await expect(
        coordinator.clear(r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_SEMANTIC_CACHE" });
      const fresh = await coordinator.prepareClear("owner");
      await expect(
        coordinator.clear(fresh.approvalToken, "other"),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      expect(
        (await coordinator.clear(fresh.approvalToken, "owner")).cleared,
      ).toBe(true);
      expect((await s.cache.stats("owner")).total).toBe(0);
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
      expect(s.records[0]).toEqual(idea);
    } finally {
      s.memory.close();
    }
  });
  it("refuses cancellation of canonical Notion operations", async () => {
    const s = setupSemantic();
    try {
      const r = await s.operations.issue("owner", "x", "create", null, null);
      await expect(s.service.cancel(r.id, "owner")).rejects.toMatchObject({
        code: "INVALID_OPERATION",
      });
      expect((await s.operations.read(r.token, "owner")).status).toBe(
        "pending",
      );
    } finally {
      s.memory.close();
    }
  });
});

describe("semantic race and ownership limits", () => {
  it("bounds all owner profiles both at review and after claim", async () => {
    const s = setupSemantic();
    try {
      const stats = vi
        .spyOn(s.cache, "stats")
        .mockResolvedValue({ total: 1000, usable: 1000 });
      await expect(
        s.service.prepareIndex(indexCommand, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_CAPACITY" });
      stats.mockResolvedValueOnce({ total: 0, usable: 0 });
      const r = await s.service.prepareIndex(indexCommand, "owner");
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_CAPACITY" });
      expect(s.provider.embed).not.toHaveBeenCalled();
    } finally {
      s.memory.close();
    }
  });
  it("leaves a different owner's vectors intact when clearing", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      await s.memory.db
        .prepare(
          "INSERT INTO idea_lab_semantic_vectors SELECT ?, profile_hash,idea_id,input_hash,input_revision,fields_json,model,dimensions,vector,vector_hash,operation_id,updated_at,expires_at FROM idea_lab_semantic_vectors WHERE owner_hash=?",
        )
        .bind(await digest("other"), await digest("owner"))
        .run();
      const r = await s.service.prepareClear("owner");
      await s.service.clear(r.approvalToken, "owner");
      expect((await s.cache.stats("owner")).total).toBe(0);
      expect((await s.cache.stats("other")).total).toBe(1);
    } finally {
      s.memory.close();
    }
  });
  it("rejects overlong retention and foreign status records", async () => {
    const s = setupSemantic();
    try {
      const r = await indexed(s);
      const rows = await s.cache.rows(
        "owner",
        await embeddingProfileHash(embeddingConfig),
      );
      await expect(
        s.cache.checked({
          ...rows[0],
          expires_at: rows[0].updated_at + 604800001,
        }),
      ).rejects.toThrow();
      await expect(
        s.service.status(
          await s.operations.read(r.approvalToken, "owner"),
          "other",
        ),
      ).rejects.toMatchObject({ code: "INVALID_OPERATION" });
    } finally {
      s.memory.close();
    }
  });
  it("cancellation between cache rows preserves verified partial rows and fences the rest", async () => {
    const s = setupSemantic();
    try {
      s.records.push({
        ...structuredClone(idea),
        id: "70000000-0000-4000-8000-000000000007",
        title: "Second synthetic idea",
      });
      const c = {
          ...indexCommand,
          records: s.records.map((r) => ({
            id: r.id,
            expectedRevision: r.revision,
          })),
        },
        r = await s.service.prepareIndex(c, "owner"),
        put = s.cache.put.bind(s.cache);
      vi.spyOn(s.cache, "put").mockImplementationOnce(async (...args) => {
        await put(...args);
        await s.service.cancel(args[5], "owner");
      });
      await expect(
        s.service.index(r.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "SEMANTIC_CANCELLED" });
      expect((await s.cache.stats("owner")).total).toBe(1);
      expect(
        (await s.service.statusToken(r.approvalToken, "owner")).status,
      ).toBe("cancelled");
      expect(s.provider.embed).toHaveBeenCalledTimes(1);
    } finally {
      s.memory.close();
    }
  });
  it("does not publish late query results after owner cancellation", async () => {
    const s = setupSemantic();
    try {
      await indexed(s);
      const r = await s.service.prepareQuery(queryCommand, "owner");
      let release!: (value: {
          vectors: number[][];
          model: string;
          tokens: number;
        }) => void,
        entered!: () => void;
      const started = new Promise<void>((resolve) => (entered = resolve));
      s.provider.embed.mockImplementationOnce(() => {
        entered();
        return new Promise((resolve) => (release = resolve));
      });
      const pending = s.service.query(r.command, r.approvalToken, "owner");
      await started;
      await s.service.cancel(
        (await s.operations.read(r.approvalToken, "owner")).id,
        "owner",
      );
      release({ vectors: [[1, 0, 0]], model: "embedding-model-v1", tokens: 1 });
      await expect(pending).rejects.toMatchObject({
        code: "SEMANTIC_CANCELLED",
      });
      expect(
        (await s.service.statusToken(r.approvalToken, "owner")).status,
      ).toBe("cancelled");
      expect((await s.cache.stats("owner")).total).toBe(1);
    } finally {
      s.memory.close();
    }
  });
});

it("bounds escaped description excerpts without ignoring full-field changes", async () => {
  const long = '\n"\\'.repeat(2000),
    record = {
      ...idea,
      title: long,
      summary: long,
      problem: long,
      solution: long,
      audience: long,
      expectedValue: long,
      context: long,
    },
    projection = await semanticInput(record, [
      "title",
      "summary",
      "problem",
      "solution",
      "audience",
      "expectedValue",
      "context",
    ]);
  expect(
    new TextEncoder().encode(projection.input).byteLength,
  ).toBeLessThanOrEqual(6000);
  for (const value of Object.values(JSON.parse(projection.input)))
    expect(
      new TextEncoder().encode(JSON.stringify(value)).byteLength - 2,
    ).toBeLessThanOrEqual(760);
  expect(projection.hash).not.toBe(
    (
      await semanticInput(
        { ...record, context: long + "hidden tail" },
        projection.fields,
      )
    ).hash,
  );
});

it("ranks nonidentical cosine vectors with explicit threshold and top-k", async () => {
  const s = setupSemantic();
  try {
    s.records.push(
      {
        ...structuredClone(idea),
        id: "70000000-0000-4000-8000-000000000007",
        title: "Second synthetic idea",
      },
      {
        ...structuredClone(idea),
        id: "80000000-0000-4000-8000-000000000008",
        title: "Opposite synthetic idea",
      },
    );
    s.provider.embed.mockResolvedValueOnce({
      vectors: [
        [3, 4, 0],
        [1, 0, 0],
        [-1, 0, 0],
      ],
      model: "embedding-model-v1",
      tokens: 3,
    });
    const c = {
        ...indexCommand,
        records: s.records.map((r) => ({
          id: r.id,
          expectedRevision: r.revision,
        })),
      },
      r = await s.service.prepareIndex(c, "owner");
    await s.service.index(r.command, r.approvalToken, "owner");
    s.provider.embed.mockResolvedValue({
      vectors: [[1, 0, 0]],
      model: "embedding-model-v1",
      tokens: 1,
    });
    const q = await s.service.prepareQuery(
        { ...queryCommand, threshold: 0.5, limit: 2 },
        "owner",
      ),
      result = await s.service.query(q.command, q.approvalToken, "owner");
    expect(result.matches.map((m) => m.idea.id)).toEqual([
      s.records[1].id,
      s.records[0].id,
    ]);
    expect(result.matches[0].similarity).toBeCloseTo(1);
    expect(result.matches[1].similarity).toBeCloseTo(0.6);
    const strict = await s.service.prepareQuery(
      { ...queryCommand, threshold: 0.75, limit: 1 },
      "owner",
    );
    expect(
      (
        await s.service.query(strict.command, strict.approvalToken, "owner")
      ).matches.map((m) => m.idea.id),
    ).toEqual([s.records[1].id]);
  } finally {
    s.memory.close();
  }
});
