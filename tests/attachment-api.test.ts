import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
vi.mock("@/app/chatgpt-auth", () => ({ getChatGPTUser: vi.fn() }));
import { getChatGPTUser } from "../app/chatgpt-auth";
import { GET, POST } from "../app/api/attachments/[action]/route";
import { uploadBody } from "../lib/attachments/access";
import { runWithIdeaRuntime } from "../lib/ideas/runtime";
import { MAX_FILE_BYTES } from "../lib/attachments/model";
import { ids } from "./fixtures";
const user = {
  userId: "owner",
  email: "owner@example.test",
  displayName: "Owner",
  fullName: null,
};
const env = { IDEA_LAB_OWNER_USER_ID: "owner" };
const context = (action: string) => ({ params: Promise.resolve({ action }) });
const request = (origin = "https://idea.test", body: any = {}) =>
  new Request("https://idea.test/api/attachments/prepare", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.mocked(getChatGPTUser).mockResolvedValue(user);
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());
describe("attachment request boundaries", () => {
  it.each([null, { ...user, userId: "foreign" }])(
    "authorizes before reads or parsing an upload",
    async (actor) => {
      vi.mocked(getChatGPTUser).mockResolvedValue(actor);
      const fetcher = vi.spyOn(globalThis, "fetch");
      const read = await runWithIdeaRuntime(env, () =>
        GET(
          new Request(
            "https://idea.test/api/attachments/list?ideaId=" + ids.idea,
          ),
          context("list"),
        ),
      );
      const write = await runWithIdeaRuntime(env, () =>
        POST(request(), context("commit")),
      );
      expect(read.status).toBe(actor ? 403 : 401);
      expect(write.status).toBe(read.status);
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
  it("rejects missing and cross-site origins before reading bytes", async () => {
    const response = await runWithIdeaRuntime(env, () =>
      POST(request("https://foreign.test"), context("commit")),
    );
    expect(response.status).toBe(403);
    const response2 = await runWithIdeaRuntime(env, () =>
      POST(
        new Request("https://idea.test/api/attachments/commit", {
          method: "POST",
          body: "x",
        }),
        context("commit"),
      ),
    );
    expect(response2.status).toBe(403);
  });
  it("bounds actual streaming bytes without relying on Content-Length", async () => {
    const req = new Request("https://idea.test/api/attachments/commit", {
      method: "POST",
      headers: {
        Origin: "https://idea.test",
        "Content-Type": "multipart/form-data; boundary=synthetic",
      },
      body: new Uint8Array(MAX_FILE_BYTES + 65537),
    });
    const response = await runWithIdeaRuntime(env, () =>
      POST(req, context("commit")),
    );
    expect(response.status).toBe(413);
  });
  it("rejects malformed, duplicate and extra multipart fields", async () => {
    for (const mode of ["duplicate", "extra", "token", "file"]) {
      const form = new FormData();
      form.append("file", new File(["x"], "note.txt"));
      form.append("approvalToken", "a".repeat(64));
      if (mode === "duplicate")
        form.append("file", new File(["y"], "second.txt"));
      if (mode === "extra") form.append("ideaId", ids.idea);
      if (mode === "token") form.set("approvalToken", "bad");
      if (mode === "file") form.set("file", "not a file");
      await expect(
        uploadBody(
          new Request("https://idea.test", { method: "POST", body: form }),
        ),
      ).rejects.toThrow();
    }
    await expect(uploadBody(request())).rejects.toMatchObject({ status: 415 });
  });
  it("accepts only one bounded file with a valid receipt", async () => {
    const form = new FormData();
    form.append("file", new File(["synthetic"], "note.txt"));
    form.append("approvalToken", "b".repeat(64));
    const parsed = await uploadBody(
      new Request("https://idea.test", { method: "POST", body: form }),
    );
    expect(await parsed.file.text()).toBe("synthetic");
    expect(parsed.token).toBe("b".repeat(64));
  });
});
