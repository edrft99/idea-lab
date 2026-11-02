import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ClaudeReviewer,
  claudeInstructions,
} from "../lib/roundtable/claude-provider";
import {
  checkedClaudeConfig,
  type ClaudeConfig,
} from "../lib/roundtable/claude-config";
import { GPTReviewer, instructions } from "../lib/roundtable/provider";
import {
  assessment,
  roundtableCommand,
  gptConfig,
} from "./roundtable-fixtures";
const config: ClaudeConfig = {
  ...gptConfig,
  provider: "anthropic-messages",
  endpoint: "https://api.anthropic.com/v1/",
  deployment: "synthetic-claude",
};
const message = (changes = {}) => ({
  type: "message",
  id: "msg_synthetic",
  model: "synthetic-claude-resolved",
  role: "assistant",
  stop_reason: "end_turn",
  content: [{ type: "text", text: JSON.stringify(assessment) }],
  usage: { input_tokens: 25, output_tokens: 100 },
  ...changes,
});
afterEach(() => vi.restoreAllMocks());
describe("Claude independent assessment transport", () => {
  it("uses the exact same evidence payload and rubric as GPT without sending peer answers or idea identifiers", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(message()));
    const result = await new ClaudeReviewer(config, fetcher).evaluate(
      roundtableCommand,
    );
    expect(result.value).toEqual(assessment);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(options.redirect).toBe("manual");
    expect(options.headers["x-api-key"]).toBe(config.key);
    expect(options.headers["anthropic-version"]).toBe("2023-06-01");
    const body = JSON.parse(options.body);
    expect(body.system).toBe(claudeInstructions);
    expect(body.system.replace("You are Claude", "You are GPT")).toBe(
      instructions,
    );
    expect(body.output_config.format.type).toBe("json_schema");
    expect(body.tools).toBeUndefined();
    expect(body.messages).toHaveLength(1);
    const gptFetch = vi.fn().mockResolvedValue(Response.json({}));
    await new GPTReviewer(gptConfig, gptFetch)
      .evaluate(roundtableCommand)
      .catch(() => {});
    const gptBody = JSON.parse(gptFetch.mock.calls[0][1].body);
    expect(body.messages[0].content).toBe(gptBody.input[0].content);
    expect(body.output_config.format.schema).toEqual(
      gptBody.text.format.schema,
    );
    expect(options.body).not.toContain(roundtableCommand.ideaId);
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 100 });
  });
  it.each([
    { stop_reason: "max_tokens" },
    { stop_reason: "refusal" },
    { content: [{ type: "tool_use", input: assessment }] },
    { content: [{ type: "text", text: "not json" }] },
    {
      content: [
        { type: "text", text: JSON.stringify({ ...assessment, ratings: {} }) },
      ],
    },
    { model: "" },
  ])(
    "rejects incomplete, refused, tool and malformed responses without retries",
    async (changes) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(Response.json(message(changes)));
      await expect(
        new ClaudeReviewer(config, fetcher).evaluate(roundtableCommand),
      ).rejects.toBeDefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([302, 401, 429, 500])(
    "does not retry provider status %s or expose the provider response",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response("private diagnostic", { status }));
      await expect(
        new ClaudeReviewer(config, fetcher).evaluate(roundtableCommand),
      ).rejects.toMatchObject({
        code: status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("redacts protected values from parsed output and provenance", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          message({
            model: config.key,
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  ...assessment,
                  summary: "Echo " + config.key + " private-fixture-token",
                }),
              },
            ],
          }),
        ),
      );
    const result = await new ClaudeReviewer(config, fetcher, [
      "private-fixture-token",
    ]).evaluate(roundtableCommand);
    expect(JSON.stringify(result)).not.toContain(config.key);
    expect(JSON.stringify(result)).not.toContain("private-fixture-token");
  });
  it("enforces bounded responses and a fixed provider origin", async () => {
    expect(() =>
      checkedClaudeConfig({ ...config, endpoint: "https://outside.test/" }),
    ).toThrow();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        new Response("{}", {
          headers: {
            "Content-Type": "application/json",
            "Content-Length": "300000",
          },
        }),
      );
    await expect(
      new ClaudeReviewer(config, fetcher).evaluate(roundtableCommand),
    ).rejects.toMatchObject({ code: "AI_OUTPUT_TOO_LARGE" });
  });
  it("honors cancellation without a replay", async () => {
    const controller = new AbortController();
    const fetcher = vi.fn().mockImplementation(async (_url, options) => {
      expect(options.signal.aborted).toBe(true);
      throw new Error("Synthetic aborted request");
    });
    controller.abort();
    await expect(
      new ClaudeReviewer(config, fetcher).evaluate(
        roundtableCommand,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "AI_REQUEST_UNCONFIRMED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
