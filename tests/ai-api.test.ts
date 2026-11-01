import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as prepare } from "../app/api/ai/evaluations/prepare/route";
import { POST as commit } from "../app/api/ai/evaluations/commit/route";
import { POST as status } from "../app/api/ai/evaluations/status/route";
import { GET as profile } from "../app/api/ai/status/route";
import { POST as reconcile } from "../app/api/operations/reconcile/route";
import { Operations } from "../lib/ideas/operations";
import { setup } from "./proposal-fixtures";
import { aiConfig, command } from "./ai-fixtures";
import { draft } from "./assessment-fixtures";
import { ids, config, page } from "./fixtures";
const owner = {
    userId: "owner",
    email: "owner@example.test",
    displayName: "Owner",
    fullName: null,
  },
  ownerEnv = { IDEA_LAB_OWNER_USER_ID: "owner" };
const req = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/ai/evaluations/request", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("AI assessment API consent and privacy boundary", () => {
  it.each([prepare, commit, status])(
    "requires owner identity, same origin and strict JSON before provider access",
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
        handler(req({ approve: true, tool: "save" })),
      );
      expect(invalid.status).toBe(400);
      expect(invalid.headers.get("Cache-Control")).toBe("private, no-store");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("keeps AI disabled without configuration and never exposes configured secrets", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    let response = await runWithIdeaRuntime(ownerEnv, () => profile());
    expect(((await response.json()) as any).data.enabled).toBe(false);
    response = await runWithIdeaRuntime(
      {
        ...ownerEnv,
        IDEA_LAB_AI_PROVIDER: "azure-openai-responses",
        IDEA_LAB_AI_API_KEY: aiConfig.key,
      },
      () => profile(),
    );
    expect(JSON.stringify(await response.json())).not.toContain(aiConfig.key);
    expect(fetcher).not.toHaveBeenCalled();
    vi.mocked(getChatGPTUser).mockResolvedValue(null);
    expect((await runWithIdeaRuntime(ownerEnv, () => profile())).status).toBe(
      401,
    );
  });
  it("dispatches only after explicit consent, never writes Notion, and routes status without replay", async () => {
    const s = setup();
    s.rows.set(ids.idea, page());
    let modelCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
      if (String(url) === aiConfig.endpoint + "responses") {
        modelCalls++;
        const { rubricVersion, weights, ...output } = draft;
        return Response.json({
          object: "response",
          id: "resp_synthetic",
          model: "resolved-model-version",
          status: "completed",
          error: null,
          incomplete_details: null,
          output: [
            {
              type: "message",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: JSON.stringify(output) }],
            },
          ],
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
      IDEA_LAB_AI_PROVIDER: aiConfig.provider,
      IDEA_LAB_AI_ENDPOINT: aiConfig.endpoint,
      IDEA_LAB_AI_DEPLOYMENT: aiConfig.deployment,
      IDEA_LAB_AI_API_KEY: aiConfig.key,
      IDEA_LAB_AI_RETENTION_NOTICE: aiConfig.retentionNotice,
    };
    try {
      const r = await runWithIdeaRuntime(env, () => prepare(req(command)));
      expect(r.status).toBe(200);
      const receipt = ((await r.json()) as any).data;
      expect(modelCalls).toBe(0);
      expect(s.writes()).toHaveLength(0);
      const committed = await runWithIdeaRuntime(env, () =>
        commit(
          req({
            command: receipt.command,
            approvalToken: receipt.approvalToken,
          }),
        ),
      );
      expect(committed.status).toBe(200);
      expect(modelCalls).toBe(1);
      expect(s.writes()).toHaveLength(0);
      const result = ((await committed.json()) as any).data.result;
      expect(result.resolvedModel).toBe("resolved-model-version");
      expect(JSON.stringify(result)).not.toContain(aiConfig.key);
      const check = await runWithIdeaRuntime(env, () =>
        status(req({ approvalToken: receipt.approvalToken })),
      );
      expect(((await check.json()) as any).data).toMatchObject({
        status: "done",
        resultRetained: false,
      });
      const op = await new Operations(s.memory.db).read(
          receipt.approvalToken,
          "owner",
        ),
        common = await runWithIdeaRuntime(env, () =>
          reconcile(req({ operationId: op.id })),
        );
      expect(common.status).toBe(200);
      expect(((await common.json()) as any).data.resultRetained).toBe(false);
      expect(modelCalls).toBe(1);
    } finally {
      s.memory.close();
    }
  });
});
