import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GrokReviewer,
  grokInstructions,
} from "../lib/roundtable/grok-provider";
import {
  checkedGrokConfig,
  type GrokConfig,
} from "../lib/roundtable/grok-config";
import { GPTReviewer, instructions } from "../lib/roundtable/provider";
import {
  assessment,
  roundtableCommand,
  gptConfig,
} from "./roundtable-fixtures";
const config: GrokConfig = {
  ...gptConfig,
  provider: "xai-chat-completions",
  endpoint: "https://api.x.ai/v1/",
  deployment: "synthetic-grok",
};
const choice = (changes = {}) => ({
  finish_reason: "stop",
  message: { role: "assistant", content: JSON.stringify(assessment) },
  ...changes,
});
const completion = (changes = {}) => ({
  object: "chat.completion",
  id: "synthetic-completion",
  model: "synthetic-grok-resolved",
  choices: [choice()],
  usage: { prompt_tokens: 25, completion_tokens: 100 },
  ...changes,
});
afterEach(() => vi.restoreAllMocks());
describe("Grok independent assessment transport", () => {
  it("uses the same GPT evidence and rubric without tools, peer answers or idea identifiers", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(completion()));
    const result = await new GrokReviewer(config, fetcher).evaluate(
      roundtableCommand,
    );
    expect(result.value).toEqual(assessment);
    const [url, options] = fetcher.mock.calls[0];
    expect(url).toBe("https://api.x.ai/v1/chat/completions");
    expect(options.redirect).toBe("manual");
    expect(options.headers.Authorization).toBe("Bearer " + config.key);
    const body = JSON.parse(options.body);
    expect(body.messages[0]).toEqual({
      role: "system",
      content: grokInstructions,
    });
    expect(grokInstructions.replace("You are Grok", "You are GPT")).toBe(
      instructions,
    );
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.tools).toBeUndefined();
    expect(body.messages).toHaveLength(2);
    expect(body.stream).toBe(false);
    expect(body.n).toBe(1);
    expect(body.max_tokens).toBe(config.maxOutputTokens);
    const gptFetch = vi.fn().mockResolvedValue(Response.json({}));
    await new GPTReviewer(gptConfig, gptFetch)
      .evaluate(roundtableCommand)
      .catch(() => {});
    const gptBody = JSON.parse(gptFetch.mock.calls[0][1].body);
    expect(body.messages[1].content).toBe(gptBody.input[0].content);
    expect(body.response_format.json_schema.schema).toEqual(
      gptBody.text.format.schema,
    );
    expect(options.body).not.toContain(roundtableCommand.ideaId);
    expect(result.usage).toEqual({ inputTokens: 25, outputTokens: 100 });
  });
  it.each([
    { choices: [choice({ finish_reason: "length" })] },
    { choices: [choice({ finish_reason: "content_filter" })] },
    {
      choices: [
        choice({
          message: {
            role: "assistant",
            content: JSON.stringify(assessment),
            refusal: "Refused",
          },
        }),
      ],
    },
    {
      choices: [
        choice({
          message: {
            role: "assistant",
            content: JSON.stringify(assessment),
            tool_calls: [{ type: "function" }],
          },
        }),
      ],
    },
    {
      choices: [
        choice({ message: { role: "assistant", content: "not json" } }),
      ],
    },
    {
      choices: [
        choice({
          message: {
            role: "assistant",
            content: JSON.stringify({ ...assessment, confidence: 2 }),
          },
        }),
      ],
    },
    { choices: [choice(), choice()] },
    { model: "" },
  ])(
    "rejects incomplete, refused, tool and malformed results without replay",
    async (changes) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(Response.json(completion(changes)));
      await expect(
        new GrokReviewer(config, fetcher).evaluate(roundtableCommand),
      ).rejects.toBeDefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it.each([302, 401, 429, 500])(
    "does not retry status %s or expose private diagnostics",
    async (status) => {
      const fetcher = vi
        .fn()
        .mockResolvedValue(new Response("private diagnostic", { status }));
      await expect(
        new GrokReviewer(config, fetcher).evaluate(roundtableCommand),
      ).rejects.toMatchObject({
        code: status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("redacts secrets from assessment strings and provenance", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json(
          completion({
            model: config.key,
            choices: [
              choice({
                message: {
                  role: "assistant",
                  content: JSON.stringify({
                    ...assessment,
                    summary: "Echo " + config.key + " private-fixture-token",
                  }),
                },
              }),
            ],
          }),
        ),
      );
    const result = await new GrokReviewer(config, fetcher, [
      "private-fixture-token",
    ]).evaluate(roundtableCommand);
    expect(JSON.stringify(result)).not.toContain(config.key);
    expect(JSON.stringify(result)).not.toContain("private-fixture-token");
  });
  it("enforces a fixed origin, bounded output and configuration limits", async () => {
    expect(() =>
      checkedGrokConfig({ ...config, endpoint: "https://outside.test/" }),
    ).toThrow();
    expect(() =>
      checkedGrokConfig({ ...config, maxOutputTokens: 100000 }),
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
      new GrokReviewer(config, fetcher).evaluate(roundtableCommand),
    ).rejects.toMatchObject({ code: "AI_OUTPUT_TOO_LARGE" });
  });
  it("honors caller cancellation without retry", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetcher = vi.fn().mockImplementation(async (_url, options) => {
      expect(options.signal.aborted).toBe(true);
      throw new Error("Synthetic abort");
    });
    await expect(
      new GrokReviewer(config, fetcher).evaluate(
        roundtableCommand,
        controller.signal,
      ),
    ).rejects.toMatchObject({ code: "AI_REQUEST_UNCONFIRMED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
