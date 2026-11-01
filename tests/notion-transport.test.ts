import { describe, it, expect, vi, afterEach } from "vitest";
import { NotionRepository } from "../lib/ideas/notion";
import { config } from "./fixtures";
afterEach(() => vi.restoreAllMocks());
describe("Workers-compatible Notion transport", () => {
  it("uses manual redirects supported by the Worker runtime", async () => {
    const request = vi.fn(async (_url: any, init?: RequestInit) => {
      if (init?.redirect === "error")
        throw new TypeError("Unsupported redirect mode");
      return Response.json({ ok: true });
    });
    expect(
      await new NotionRepository(config, request).call("users/me"),
    ).toEqual({ ok: true });
    expect(request.mock.calls[0][1]?.redirect).toBe("manual");
    expect(request.mock.calls[0][1]?.cache).toBe("no-store");
  });
  it("refuses a redirect response without following it or forwarding credentials", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { Location: "https://untrusted.example.test/collect" },
        }),
    );
    await expect(
      new NotionRepository(config, request).call("users/me"),
    ).rejects.toMatchObject({
      code: "NOTION_REDIRECT_REFUSED",
      uncertain: false,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("keeps redirected mutation outcomes uncertain instead of automatically replaying", async () => {
    const request = vi.fn(
      async () =>
        new Response(null, {
          status: 303,
          headers: { Location: "https://untrusted.example.test/collect" },
        }),
    );
    await expect(
      new NotionRepository(config, request).call("pages", "POST", {
        properties: {},
      }),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN", uncertain: true });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("logs only fixed transport categories, excluding secret values and paths", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const error = Object.assign(
      new TypeError(config.token + " C:\\Users\\synthetic\\private"),
      { cause: { code: "EACCES" } },
    );
    const request = vi.fn(async () => {
      throw error;
    });
    await expect(
      new NotionRepository(config, request).call("users/me"),
    ).rejects.toMatchObject({ code: "NOTION_UNAVAILABLE" });
    const output = JSON.stringify(log.mock.calls);
    expect(output).toContain("EACCES");
    expect(output).not.toContain(config.token);
    expect(output).not.toContain("synthetic");
    expect(output).not.toContain("Authorization");
  });
});
