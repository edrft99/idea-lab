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
  it.each([prepare, commit, status])(
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
