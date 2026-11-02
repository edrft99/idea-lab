import { POST as autoSave } from "../app/api/roundtable/reports/auto-save/route";
import { POST as savePrepare } from "../app/api/roundtable/reports/prepare/route";
import { POST as saveCommit } from "../app/api/roundtable/reports/commit/route";
import { POST as saveStatus } from "../app/api/roundtable/reports/status/route";
import { GET as savedReports } from "../app/api/roundtable/reports/route";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { POST as prepare } from "../app/api/roundtable/prepare/route";
import { POST as commit } from "../app/api/roundtable/commit/route";
import { POST as status } from "../app/api/roundtable/request-status/route";
import { GET as connection } from "../app/api/roundtable/status/route";
import { gptConfig } from "./roundtable-fixtures";
const owner = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const env = { IDEA_LAB_OWNER_USER_ID: "owner" };
const request = (body: unknown, origin = "https://idea.test") =>
  new Request("https://idea.test/api/roundtable/prepare", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(owner);
});
afterEach(() => {
  vi.restoreAllMocks();
});
describe("roundtable API boundary", () => {
  it.each([
    prepare,
    commit,
    status,
    savePrepare,
    saveCommit,
    saveStatus,
    autoSave,
  ])(
    "requires the owner, same origin and a strict payload before accessing GPT",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      vi.mocked(getChatGPTUser).mockResolvedValue(null);
      expect(
        (await runWithIdeaRuntime(env, () => handler(request({})))).status,
      ).toBe(401);
      vi.mocked(getChatGPTUser).mockResolvedValue({
        ...owner,
        userId: "other",
      });
      expect(
        (await runWithIdeaRuntime(env, () => handler(request({})))).status,
      ).toBe(403);
      vi.mocked(getChatGPTUser).mockResolvedValue(owner);
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            handler(request({}, "https://outside.test")),
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await runWithIdeaRuntime(env, () =>
            handler(request({ approve: true, tool: "save" })),
          )
        ).status,
      ).toBe(400);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("shows missing configuration without exposing secrets or fake readiness", async () => {
    const response = await runWithIdeaRuntime(env, () => connection());
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    const body: any = await response.json();
    expect(body.data.gpt.enabled).toBe(false);
    expect(body.data.claude.enabled).toBe(false);
  });
  it("returns only public connection metadata without contacting a provider", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await runWithIdeaRuntime(
      {
        ...env,
        IDEA_LAB_GPT_PROVIDER: "openai-responses",
        IDEA_LAB_GPT_MODEL: gptConfig.deployment,
        IDEA_LAB_GPT_API_KEY: gptConfig.key,
        IDEA_LAB_GPT_RETENTION_NOTICE: gptConfig.retentionNotice,
      },
      () => connection(),
    );
    const body: any = await response.json();
    expect(body.data.gpt.enabled).toBe(true);
    expect(body.data.gpt.profile.deployment).toBe(gptConfig.deployment);
    expect(JSON.stringify(body)).not.toContain(gptConfig.key);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("saved report reads", () => {
  it("requires owner identity before reading Notion history", async () => {
    vi.mocked(getChatGPTUser).mockResolvedValue(null);
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await runWithIdeaRuntime(env, () =>
      savedReports(
        new Request(
          "https://idea.test/api/roundtable/reports?ideaId=50000000-0000-4000-8000-000000000005",
        ),
      ),
    );
    expect(response.status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("rejects a malformed idea reference before provider or Notion access", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await runWithIdeaRuntime(env, () =>
      savedReports(
        new Request(
          "https://idea.test/api/roundtable/reports?ideaId=not-an-id",
        ),
      ),
    );
    expect(response.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("Claude connection boundary", () => {
  it("exposes Claude availability only when protected model, key and policy are configured", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch");
    const response = await runWithIdeaRuntime(
      {
        ...env,
        IDEA_LAB_CLAUDE_MODEL: "synthetic-claude",
        IDEA_LAB_CLAUDE_API_KEY: "synthetic-anthropic-key",
        IDEA_LAB_CLAUDE_RETENTION_NOTICE: "Synthetic API policy.",
      },
      () => connection(),
    );
    const body = (await response.json()) as any;
    expect(body.data.claude.enabled).toBe(true);
    expect(body.data.claude.profile.endpoint).toBe(
      "https://api.anthropic.com/v1/",
    );
    expect(body.data.claude.profile.requestStorage).not.toContain(
      "store=false",
    );
    expect(JSON.stringify(body)).not.toContain("synthetic-anthropic-key");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([prepare, commit])(
    "rejects an unsupported reviewer before accessing model or Notion",
    async (handler) => {
      const fetcher = vi.spyOn(globalThis, "fetch");
      const req = new Request(
        "https://idea.test/api/roundtable/prepare?reviewer=outside",
        {
          method: "POST",
          headers: {
            Origin: "https://idea.test",
            "Content-Type": "application/json",
          },
          body: "{}",
        },
      );
      expect((await runWithIdeaRuntime(env, () => handler(req))).status).toBe(
        400,
      );
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
