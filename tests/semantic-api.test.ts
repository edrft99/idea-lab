import { POST as prepareAssessment } from "../app/api/ai/evaluations/prepare/route";
import { POST as prepareExtraction } from "../app/api/ai/extractions/prepare/route";
import { aiConfig, command as assessmentCommand } from "./ai-fixtures";
import { source as extractionSource } from "./proposal-fixtures";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as prepareIndex } from "../app/api/semantic/index/prepare/route";
import { POST as commitIndex } from "../app/api/semantic/index/commit/route";
import { POST as prepareQuery } from "../app/api/semantic/query/prepare/route";
import { POST as commitQuery } from "../app/api/semantic/query/commit/route";
import { POST as prepareClear } from "../app/api/semantic/clear/prepare/route";
import { POST as commitClear } from "../app/api/semantic/clear/commit/route";
import { POST as cancel } from "../app/api/semantic/cancel/route";
import {
  GET as profile,
  POST as status,
} from "../app/api/semantic/status/route";
import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { Operations } from "../lib/ideas/operations";
import { setup } from "./proposal-fixtures";
import {
  embeddingConfig,
  indexCommand,
  queryCommand,
} from "./semantic-fixtures";
import { ids, config, page, idea } from "./fixtures";
const owner = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  ownerEnv = { IDEA_LAB_OWNER_USER_ID: "owner" };
const req = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/semantic/request", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("semantic API privacy and approval boundaries", () => {
  it.each([
    prepareIndex,
    commitIndex,
    prepareQuery,
    commitQuery,
    prepareClear,
    commitClear,
    cancel,
    status,
  ])(
    "requires owner, origin and strict JSON before model or Notion access",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect(
        (await runWithIdeaRuntime(ownerEnv, () => handler(req({})))).status,
      ).toBe(401);
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect(
        (await runWithIdeaRuntime(ownerEnv, () => handler(req({})))).status,
      ).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue(owner);
      expect(
        (
          await runWithIdeaRuntime(ownerEnv, () =>
            handler(req({}, "https://outside.test")),
          )
        ).status,
      ).toBe(403);
      const invalid = await runWithIdeaRuntime(ownerEnv, () =>
        handler(req({ tool: "run", approve: true })),
      );
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("stays disabled without model settings and never returns credentials", async () => {
    const s = setup();
    try {
      const env = {
        ...ownerEnv,
        DB: s.memory.db,
        IDEA_LAB_EMBEDDING_API_KEY: embeddingConfig.key,
      };
      const r = await runWithIdeaRuntime(env, () => profile());
      expect(r.status).toBe(200);
      const b = (await r.json()) as any;
      expect(b.data.enabled).toBe(false);
      expect(JSON.stringify(b)).not.toContain(embeddingConfig.key);
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect((await runWithIdeaRuntime(env, () => profile())).status).toBe(401);
    } finally {
      s.memory.close();
    }
  });
  it("indexes and queries only after review, returns canonical links, and clears with model settings removed", async () => {
    const s = setup();
    s.rows.set(ids.idea, page());
    let calls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === embeddingConfig.endpoint + "embeddings") {
        calls++;
        const inputs = JSON.parse(String(init?.body)).input;
        return Response.json({
          object: "list",
          model: "embedding-model-v1",
          data: inputs.map((_: string, index: number) => ({
            object: "embedding",
            index,
            embedding: [3, 4, 0],
          })),
          usage: { total_tokens: 5 },
        });
      }
      return s.fetcher(url, init);
    });
    const env = {
      ...ownerEnv,
      DB: s.memory.db,
      NOTION_TOKEN: config.token,
      NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
      NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
      NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
      NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
      IDEA_LAB_EMBEDDING_ENDPOINT: embeddingConfig.endpoint,
      IDEA_LAB_EMBEDDING_DEPLOYMENT: embeddingConfig.deployment,
      IDEA_LAB_EMBEDDING_API_KEY: embeddingConfig.key,
      IDEA_LAB_EMBEDDING_DIMENSIONS: "3",
      IDEA_LAB_EMBEDDING_VERSION: embeddingConfig.versionLabel,
      IDEA_LAB_EMBEDDING_RETENTION_NOTICE: embeddingConfig.retentionNotice,
    };
    try {
      const r = await runWithIdeaRuntime(env, () =>
        prepareIndex(req(indexCommand)),
      );
      expect(r.status).toBe(200);
      const receipt = ((await r.json()) as any).data;
      expect(calls).toBe(0);
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            commitIndex(
              req({
                command: receipt.command,
                approvalToken: receipt.approvalToken,
              }),
            ),
          )
        ).status,
      ).toBe(200);
      expect(calls).toBe(1);
      const q = await runWithIdeaRuntime(env, () =>
          prepareQuery(req(queryCommand)),
        ),
        qr = ((await q.json()) as any).data;
      expect(q.status).toBe(200);
      const result = await runWithIdeaRuntime(env, () =>
        commitQuery(
          req({ command: qr.command, approvalToken: qr.approvalToken }),
        ),
      );
      expect(result.status).toBe(200);
      expect(((await result.json()) as any).data.matches[0].idea.url).toBe(
        idea.url,
      );
      const ledger = new Operations(s.memory.db),
        op = await ledger.read(qr.approvalToken, "owner"),
        minimal = { ...ownerEnv, DB: s.memory.db };
      const common = await runWithIdeaRuntime(minimal, () =>
        reconcile(req({ operationId: op.id })),
      );
      expect(((await common.json()) as any).data).toMatchObject({
        status: "done",
        resultRetained: false,
      });
      const c = await runWithIdeaRuntime(minimal, () =>
          prepareClear(req({ scope: "all-my-semantic-vectors" })),
        ),
        cr = ((await c.json()) as any).data;
      expect(c.status).toBe(200);
      expect(
        (
          await runWithIdeaRuntime(minimal, () =>
            commitClear(
              req({ command: cr.command, approvalToken: cr.approvalToken }),
            ),
          )
        ).status,
      ).toBe(200);
      const view = await runWithIdeaRuntime(minimal, () => profile());
      expect(((await view.json()) as any).data.cache.total).toBe(0);
      expect(calls).toBe(2);
      expect(s.writes()).toHaveLength(0);
      const pending = await ledger.issue(
        "owner",
        "x",
        "semantic-query",
        "fixture",
        null,
      );
      expect(
        (
          await runWithIdeaRuntime(minimal, () =>
            cancel(req({ approvalToken: pending.token })),
          )
        ).status,
      ).toBe(200);
      expect((await ledger.read(pending.token, "owner")).status).toBe(
        "cancelled",
      );
      const canonical = await ledger.issue("owner", "x", "create", null, null);
      expect(
        (
          await runWithIdeaRuntime(minimal, () =>
            cancel(req({ operationId: canonical.id })),
          )
        ).status,
      ).toBe(400);
      expect((await ledger.read(canonical.token, "owner")).status).toBe(
        "pending",
      );
    } finally {
      s.memory.close();
    }
  });
});

it.each([
  {
    handler: prepareAssessment,
    command: {
      ...assessmentCommand,
      selection: { summary: "Selected fixture " + embeddingConfig.key },
    },
  },
  {
    handler: prepareExtraction,
    command: {
      source: {
        ...extractionSource,
        evidence: "Selected fixture " + embeddingConfig.key,
      },
    },
  },
])(
  "redacts the embedding credential before other provider consent",
  async ({ handler, command }) => {
    const s = setup();
    s.rows.set(ids.idea, page());
    vi.spyOn(globalThis, "fetch").mockImplementation(s.fetcher);
    const env = {
      ...ownerEnv,
      DB: s.memory.db,
      NOTION_TOKEN: config.token,
      NOTION_IDEAS_DATA_SOURCE_ID: ids.ideas,
      NOTION_SOURCES_DATA_SOURCE_ID: ids.sources,
      NOTION_EVALUATIONS_DATA_SOURCE_ID: ids.evaluations,
      NOTION_REVIEWS_DATA_SOURCE_ID: ids.reviews,
      IDEA_LAB_AI_PROVIDER: aiConfig.provider,
      IDEA_LAB_AI_ENDPOINT: aiConfig.endpoint,
      IDEA_LAB_AI_DEPLOYMENT: aiConfig.deployment,
      IDEA_LAB_AI_API_KEY: aiConfig.key,
      IDEA_LAB_AI_RETENTION_NOTICE: aiConfig.retentionNotice,
      IDEA_LAB_EMBEDDING_API_KEY: embeddingConfig.key,
    };
    try {
      const response = await runWithIdeaRuntime(env, () =>
        handler(req(command)),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain(embeddingConfig.key);
      expect(JSON.stringify(body)).toContain("[REDACTED]");
      expect(s.writes()).toHaveLength(0);
    } finally {
      s.memory.close();
    }
  },
);
