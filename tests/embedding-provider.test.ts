import { describe, it, expect, vi, afterEach } from "vitest";
import { AzureEmbeddingProvider } from "../lib/intelligence/embedding-provider";
import { embeddingConfig } from "./semantic-fixtures";
const output = (
  data: unknown[] = [{ object: "embedding", index: 0, embedding: [3, 4, 0] }],
) => ({
  object: "list",
  model: "embedding-model-v1",
  data,
  usage: { total_tokens: 7 },
});
afterEach(() => vi.restoreAllMocks());
describe("Azure embedding protocol", () => {
  it("uses the fixed Azure v1 destination, secret header, float encoding and only selected inputs", async () => {
    const fetcher = vi.fn(async () => Response.json(output()));
    const provider = new AzureEmbeddingProvider(embeddingConfig, fetcher);
    expect(await provider.embed(["selected excerpt"])).toEqual({
      vectors: [[0.6, 0.8, 0]],
      model: "embedding-model-v1",
      tokens: 7,
    });
    const [url, init] = fetcher.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(embeddingConfig.endpoint + "embeddings");
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("api-key")).toBe(embeddingConfig.key);
    expect(JSON.parse(String(init.body))).toEqual({
      model: embeddingConfig.deployment,
      input: ["selected excerpt"],
      encoding_format: "float",
    });
  });
  it("sends optional dimensions only when explicitly configured and reorders indexed output", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        output([
          { object: "embedding", index: 1, embedding: [0, 3, 0] },
          { object: "embedding", index: 0, embedding: [3, 0, 0] },
        ]),
      ),
    );
    const provider = new AzureEmbeddingProvider(
      { ...embeddingConfig, requestDimensions: true },
      fetcher,
    );
    expect((await provider.embed(["a", "b"])).vectors).toEqual([
      [1, 0, 0],
      [0, 1, 0],
    ]);
    expect(
      JSON.parse(
        String(
          (fetcher.mock.calls[0] as unknown as [string, RequestInit])[1].body,
        ),
      ).dimensions,
    ).toBe(3);
  });
  it.each(
    [
      [],
      [{ object: "embedding", index: 0, embedding: [0, 0, 0] }],
      [{ object: "embedding", index: 0, embedding: [1, 2] }],
      [{ object: "embedding", index: 1, embedding: [1, 0, 0] }],
      [{ object: "embedding", index: 0, embedding: ["1", 0, 0] }],
      [{ object: "embedding", index: 0, embedding: [1, null, 0] }],
    ].map((data) => ({ data })),
  )("rejects incomplete or invalid vectors without retry", async ({ data }) => {
    const fetcher = vi.fn(async () => Response.json(output(data)));
    await expect(
      new AzureEmbeddingProvider(embeddingConfig, fetcher).embed(["a"]),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNCONFIRMED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects duplicate output indices and secret-bearing model metadata", async () => {
    const fetcher = vi.fn(async () =>
      Response.json(
        output([
          { object: "embedding", index: 0, embedding: [1, 0, 0] },
          { object: "embedding", index: 0, embedding: [0, 1, 0] },
        ]),
      ),
    );
    await expect(
      new AzureEmbeddingProvider(embeddingConfig, fetcher).embed(["a", "b"]),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNCONFIRMED" });
    fetcher.mockImplementationOnce(async () =>
      Response.json({ ...output(), model: embeddingConfig.key }),
    );
    try {
      await new AzureEmbeddingProvider(embeddingConfig, fetcher).embed(["a"]);
      throw new Error("Expected failure");
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(embeddingConfig.key);
    }
  });
  it.each([302, 429, 500])(
    "does not follow or retry provider status %s",
    async (status) => {
      const fetcher = vi.fn(
        async () =>
          new Response("secret upstream diagnostic", {
            status,
            headers: { Location: "https://outside.test" },
          }),
      );
      await expect(
        new AzureEmbeddingProvider(embeddingConfig, fetcher).embed(["a"]),
      ).rejects.toMatchObject({
        code: status === 429 ? "AI_RATE_LIMITED" : "AI_PROVIDER_FAILED",
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("bounds the response and refuses oversized input before transport", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response("{}", { headers: { "Content-Length": "4194305" } }),
    );
    await expect(
      new AzureEmbeddingProvider(embeddingConfig, fetcher).embed(["a"]),
    ).rejects.toThrow();
    await expect(
      new AzureEmbeddingProvider(embeddingConfig, fetcher).embed([
        "x".repeat(6001),
      ]),
    ).rejects.toMatchObject({ code: "INVALID_EMBEDDING_INPUT" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("passes parent cancellation to the single request and safely bounds timeout failures", async () => {
    const parent = new AbortController();
    parent.abort();
    const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new Error("secret diagnostic");
    });
    await expect(
      new AzureEmbeddingProvider(embeddingConfig, fetcher).embed(
        ["a"],
        parent.signal,
      ),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNCONFIRMED" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it("aborts embedding transport at its deadline without retrying", async () => {
  const fetcher = vi.fn(
    async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new Error("Synthetic private transport error")),
          { once: true },
        );
      }),
  );
  await expect(
    new AzureEmbeddingProvider(embeddingConfig, fetcher).embed([
      "selected excerpt",
    ]),
  ).rejects.toMatchObject({ code: "EMBEDDING_UNCONFIRMED" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
