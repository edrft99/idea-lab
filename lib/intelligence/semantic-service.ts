import { semanticActions } from "./semantic-actions";
import { z } from "zod";
import { AppError } from "../ideas/errors";
import { Operations, digest, type Operation } from "../ideas/operations";
import { NotionRepository } from "../ideas/notion";
import { redact } from "../imports/staging";
import {
  indexCommandSchema,
  queryCommandSchema,
  clearCommandSchema,
  semanticInput,
  unitVector,
  cosine,
  inputVersion,
  type IndexCommand,
  type QueryCommand,
} from "./semantic-model";
import { SemanticCache, cacheLock } from "./semantic-cache";
import {
  checkedEmbeddingConfig,
  embeddingProfile,
  embeddingProfileHash,
  type EmbeddingConfig,
} from "./embedding-config";
import type { EmbeddingProvider } from "./embedding-provider";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const manifestSchema = z
  .object({
    version: z.literal(1),
    profile: hash,
    context: hash,
    manifest: hash,
    count: z.number().int().min(1).max(20),
    dimensions: z.number().int().min(1).max(4096),
  })
  .strict();
const manifestHash = (
  items: {
    id: string;
    inputHash: string;
    revision: string;
    fields: string[];
  }[],
) =>
  digest(
    JSON.stringify(
      items
        .map(({ id, inputHash, revision, fields }) => ({
          id,
          inputHash,
          revision,
          fields,
        }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    ),
  );
export type SemanticStatus = {
  status: string;
  resultRetained?: boolean;
  message: string;
  canResume: boolean;
};
export class SemanticCoordinator {
  constructor(
    protected operations: Operations,
    protected cache: SemanticCache,
  ) {}
  async status(op: Operation, actor: string): Promise<SemanticStatus> {
    if (op.actor_hash !== (await digest(actor)))
      throw new AppError(
        "INVALID_OPERATION",
        "This operation does not belong to the current user.",
        403,
      );
    if (!semanticActions.some((action) => action === op.action))
      throw new AppError(
        "INVALID_OPERATION",
        "This is not a semantic operation.",
        400,
      );
    if (op.status === "done")
      return {
        status: "done",
        resultRetained: op.action !== "semantic-query",
        message:
          op.action === "semantic-query"
            ? "The query completed. Results are kept only in its browser; no query replay was made."
            : "The derived cache operation completed.",
        canResume: false,
      };
    if (
      ["semantic-index", "semantic-snapshot-batch"].includes(op.action) &&
      ["running", "uncertain", "failed"].includes(op.status)
    ) {
      let rawContext;
      try {
        rawContext = JSON.parse(op.expected_revision ?? "null");
      } catch {}
      const context = manifestSchema.safeParse(rawContext);
      if (context.success) {
        const rows = await this.cache.byOperation(actor, op.id),
          valid = [];
        try {
          for (const row of rows) valid.push(await this.cache.checked(row));
        } catch {
          return {
            status: op.status,
            canResume: false,
            message:
              "Some cache rows are invalid. Cancel an interrupted operation and explicitly rebuild; no model call was replayed.",
          };
        }
        const records = valid.map((r) => ({
          id: r.idea_id,
          inputHash: r.input_hash,
          revision: r.input_revision,
          fields: r.fields,
        }));
        if (
          rows.length === context.data.count &&
          valid.every(
            (r) =>
              r.profile_hash === context.data.profile &&
              r.dimensions === context.data.dimensions,
          ) &&
          new Set(valid.map((r) => r.model)).size === 1 &&
          (await manifestHash(records)) === context.data.manifest
        ) {
          if (
            await this.operations.confirmSemanticIndex(
              op.id,
              context.data.manifest,
            )
          )
            return {
              status: "done",
              resultRetained: true,
              canResume: false,
              message:
                "The approved index batch was verified without replaying the model request.",
            };
        }
      }
    }
    return {
      status: op.status,
      resultRetained: false,
      canResume: false,
      message:
        op.status === "cancelled"
          ? "This derived operation was cancelled. The provider may still have processed its request; already committed derived changes and verified partial cache rows can remain."
          : "No complete retained result was confirmed. Check the cache, cancel an interrupted operation if needed, then explicitly review any rebuild.",
    };
  }
  async cancel(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    await this.operations.cancelSemantic(op);
    return this.status(await this.operations.readById(id, actor), actor);
  }
  async reconcile(id: string, actor: string) {
    return this.status(await this.operations.readById(id, actor), actor);
  }
  async statusToken(token: string, actor: string) {
    return this.status(await this.operations.read(token, actor), actor);
  }
  async prepareClear(actor: string) {
    const state = await this.cache.fingerprint(actor),
      command = clearCommandSchema.parse({ scope: "all-my-semantic-vectors" });
    if (!state.count && !state.snapshotCount && !state.active)
      throw new AppError(
        "SEMANTIC_CACHE_EMPTY",
        "There are no retained semantic vectors to clear.",
        400,
      );
    const r = await this.operations.issue(
      actor,
      await digest(JSON.stringify(command)),
      "semantic-clear",
      await cacheLock(actor),
      state.hash,
    );
    return {
      approvalToken: r.token,
      expiresAt: new Date(r.expires).toISOString(),
      command,
      changes: [
        {
          field: "Derived cache",
          before:
            state.count +
            " retained vectors, " +
            state.snapshotCount +
            " snapshot manifests" +
            (state.active ? " and an active pointer" : ""),
          after:
            "Clear only this owner's semantic vectors, snapshot manifests and active pointer across model profiles. Notion ideas, sources, evaluations and approval history stay intact. Rebuilding requires selected-content/model consent.",
        },
      ],
    };
  }
  async clear(token: string, actor: string) {
    const op = await this.operations.read(token, actor),
      command = clearCommandSchema.parse({ scope: "all-my-semantic-vectors" }),
      payload = await digest(JSON.stringify(command));
    if (
      op.action !== "semantic-clear" ||
      op.payload_hash !== payload ||
      op.target !== (await cacheLock(actor))
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "This is not a semantic-cache clearing approval.",
        400,
      );
    if (op.status === "done") return { status: "done", cleared: true };
    await this.operations.claim(op, payload);
    try {
      if ((await this.cache.fingerprint(actor)).hash !== op.expected_revision)
        throw new AppError(
          "STALE_SEMANTIC_CACHE",
          "The cache changed. Review clearing it again.",
          409,
        );
      await this.cache.clear(actor, op.id);
      if (!(await this.operations.finishRunning(op.id, "done")))
        throw new AppError(
          "SEMANTIC_CANCELLED",
          "This cache operation was cancelled.",
          409,
        );
      return { status: "done", cleared: true };
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
}
export class SemanticService extends SemanticCoordinator {
  protected config: EmbeddingConfig;
  constructor(
    config: EmbeddingConfig,
    protected repository: NotionRepository,
    operations: Operations,
    cache: SemanticCache,
    protected provider: EmbeddingProvider,
    protected secrets: string[] = [],
  ) {
    super(operations, cache);
    this.config = checkedEmbeddingConfig(config);
  }
  protected async context() {
    return digest(
      JSON.stringify([
        embeddingProfile(this.config),
        await digest(this.config.key),
      ]),
    );
  }
  private async records(command: IndexCommand) {
    const records = [];
    for (const chosen of command.records) {
      const idea = await this.repository.getSemanticIdea(chosen.id);
      if (idea.canonicalIdeaId)
        throw new AppError(
          "SUPERSEDED_IDEA",
          "Index the surviving canonical idea.",
          409,
          undefined,
          false,
          [idea.canonicalIdeaId],
        );
      if (idea.revision !== chosen.expectedRevision)
        throw new AppError(
          "STALE_IDEA",
          "An idea changed after selection. Reload before reviewing its embedding.",
          409,
          undefined,
          false,
          [idea.id],
        );
      let projection;
      try {
        projection = await semanticInput(idea, command.fields, [
          this.config.key,
          ...this.secrets,
        ]);
      } catch {
        throw new AppError(
          "SEMANTIC_INPUT_EMPTY",
          "Choose description fields with content for each selected idea.",
          400,
          undefined,
          false,
          [idea.id],
        );
      }
      records.push({
        id: idea.id,
        title: idea.title,
        revision: idea.revision,
        inputHash: projection.hash,
        fields: projection.fields,
        input: projection.input,
      });
    }
    return records;
  }
  protected async receipt<C>(
    command: C,
    actor: string,
    action: string,
    target: string,
    revision: string,
    changes: { field: string; before: string; after: string }[],
  ) {
    const r = await this.operations.issue(
      actor,
      await digest(JSON.stringify(command)),
      action,
      target,
      revision,
    );
    return {
      approvalToken: r.token,
      expiresAt: new Date(r.expires).toISOString(),
      command,
      changes: [
        {
          field: "Embedding destination",
          before: "No transmission",
          after:
            this.config.endpoint +
            "embeddings\nDeployment: " +
            this.config.deployment +
            " · version label: " +
            this.config.versionLabel +
            " · " +
            this.config.dimensions +
            " dimensions",
        },
        ...changes,
        {
          field: "Retention and limits",
          before: "",
          after:
            this.config.retentionNotice +
            "\nDerived vectors expire after " +
            this.config.cacheSeconds +
            " seconds and are physically cleaned on semantic-cache access. No query text/vector is retained. Shared " +
            this.config.requestsPerHour +
            " AI attempts per owner/hour; one request, no automatic retry. Provider processing may incur charges.",
        },
      ],
    };
  }
  async prepareIndex(input: IndexCommand, actor: string) {
    if (await this.cache.snapshots.reference(actor))
      throw new AppError(
        "SEMANTIC_SNAPSHOT_ACTIVE",
        "A snapshot governs search. Build a complete replacement or explicitly clear the cache before sparse indexing.",
        409,
      );
    let command = indexCommandSchema.parse(input);
    await this.cache.purgeExpired(actor);
    const profile = await embeddingProfileHash(this.config),
      existing = await this.cache.rows(actor, profile),
      records = await this.records(command);
    const work = [];
    for (const record of records) {
      const old = existing.find((r) => r.idea_id === record.id);
      let fresh = false;
      try {
        if (old) {
          const checked = await this.cache.checked(old);
          fresh =
            checked.input_hash === record.inputHash &&
            checked.dimensions === this.config.dimensions &&
            JSON.stringify(checked.fields) === JSON.stringify(record.fields);
        }
      } catch {}
      if (command.refresh || !fresh) work.push(record);
    }
    if (!work.length)
      throw new AppError(
        "SEMANTIC_INDEX_CURRENT",
        "The selected fields already have current vectors. Select explicit regeneration if the deployment changed.",
        400,
      );
    if (
      (await this.cache.stats(actor)).total +
        work.filter((r) => !existing.some((old) => old.idea_id === r.id))
          .length >
      1000
    )
      throw new AppError(
        "SEMANTIC_CAPACITY",
        "Your cache is limited to 1,000 vectors across profiles. Clear the derived index before adding more.",
        409,
      );
    command = indexCommandSchema.parse({
      ...command,
      records: work.map((r) => ({ id: r.id, expectedRevision: r.revision })),
    });
    const context = manifestSchema.parse({
      version: 1,
      profile,
      context: await this.context(),
      manifest: await manifestHash(work),
      count: work.length,
      dimensions: this.config.dimensions,
    });
    return this.receipt(
      command,
      actor,
      "semantic-index",
      "semantic-index:" + (await digest(actor)) + ":" + profile,
      JSON.stringify(context),
      [
        {
          field: "Exact description excerpts",
          before: "",
          after: work.map((r) => r.title + "\n" + r.input).join("\n\n"),
        },
        {
          field: "Scope",
          before: "",
          after:
            "Generate vectors for " +
            work.length +
            " explicitly selected records/fields. Each field is redacted and limited to 760 escaped JSON UTF-8 bytes. Store only vectors, identifiers, hashes, selected-field names and model/version metadata in a rebuildable cache. No Notion record, score or description changes.",
        },
      ],
    );
  }
  private normalizedQuery(input: QueryCommand) {
    const c = queryCommandSchema.parse(input);
    return queryCommandSchema.parse({
      ...c,
      query: redact(c.query, [this.config.key, ...this.secrets]),
    });
  }
  async prepareQuery(input: QueryCommand, actor: string) {
    const c = this.normalizedQuery(input);
    await this.cache.purgeExpired(actor);
    if (
      !(await this.cache.rows(actor, await embeddingProfileHash(this.config)))
        .length
    )
      throw new AppError(
        "SEMANTIC_INDEX_EMPTY",
        "Index selected ideas before requesting semantic search.",
        409,
      );
    return this.receipt(
      c,
      actor,
      "semantic-query",
      "semantic-query:" + (await digest(actor)),
      await this.context(),
      [
        { field: "Exact query", before: "", after: c.query },
        {
          field: "Filters and threshold",
          before: "",
          after:
            JSON.stringify(c.filters) +
            "\nMinimum cosine similarity: " +
            c.threshold +
            " · limit: " +
            c.limit,
        },
        {
          field: "Scope",
          before: "",
          after:
            "Send only this query for one embedding. Compare compatible cached vectors, verify current Notion descriptions, and return canonical links. No cached idea text is sent to the model. Similarity is not a duplicate decision. No Notion write, score, merge or query retention.",
        },
      ],
    );
  }
  protected confirmed(
    generated: Awaited<ReturnType<EmbeddingProvider["embed"]>>,
    count: number,
  ) {
    if (
      generated.vectors.length !== count ||
      !generated.model ||
      generated.model.length > 200 ||
      redact(generated.model, [this.config.key, ...this.secrets]) !==
        generated.model
    )
      throw new AppError(
        "EMBEDDING_UNCONFIRMED",
        "The embedding response is incompatible with this request.",
        502,
      );
    return {
      ...generated,
      vectors: generated.vectors.map((v) =>
        unitVector(v, this.config.dimensions),
      ),
    };
  }
  protected async claim(
    command: unknown,
    token: string,
    actor: string,
    action: string,
  ) {
    const op = await this.operations.read(token, actor),
      payload = await digest(JSON.stringify(command));
    if (op.action !== action || op.payload_hash !== payload)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The semantic request changed. Review transmission again.",
        409,
      );
    if (op.status === "done")
      throw new AppError(
        "SEMANTIC_REQUEST_USED",
        "This request completed and will not be replayed. Check its status or review a new request.",
        409,
      );
    await this.operations.claim(op, payload, [
      await cacheLock(actor),
      "ai-budget:" + (await digest(actor)),
    ]);
    if (
      (await this.operations.countAIAttempts(actor, Date.now() - 3600000)) >
      this.config.requestsPerHour
    ) {
      await this.operations.finishRunning(op.id, "failed");
      throw new AppError(
        "AI_BUDGET_EXHAUSTED",
        "The shared AI request budget has been reached. No model call was made.",
        429,
      );
    }
    return op;
  }
  async index(
    input: IndexCommand,
    token: string,
    actor: string,
    signal?: AbortSignal,
  ) {
    const c = indexCommandSchema.parse(input),
      op = await this.operations.read(token, actor);
    if (op.action !== "semantic-index")
      throw new AppError(
        "APPROVAL_CHANGED",
        "This is not an index approval.",
        409,
      );
    let rawContext;
    try {
      rawContext = JSON.parse(op.expected_revision ?? "null");
    } catch {}
    const context = manifestSchema.parse(rawContext);
    if (
      context.context !== (await this.context()) ||
      context.profile !== (await embeddingProfileHash(this.config)) ||
      op.target !==
        "semantic-index:" + (await digest(actor)) + ":" + context.profile
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "Embedding configuration changed. Review the request again.",
        409,
      );
    await this.claim(c, token, actor, "semantic-index");
    try {
      if (await this.cache.snapshots.reference(actor))
        throw new AppError(
          "SEMANTIC_SNAPSHOT_ACTIVE",
          "The search snapshot changed. Review a complete rebuild instead of modifying active vectors.",
          409,
        );
      const records = await this.records(c);
      if (
        records.length !== context.count ||
        (await manifestHash(records)) !== context.manifest
      )
        throw new AppError(
          "APPROVAL_CHANGED",
          "The selected canonical input changed.",
          409,
        );
      await this.cache.purgeExpired(actor);
      const existing = await this.cache.rows(actor, context.profile);
      if (
        (await this.cache.stats(actor)).total +
          records.filter((r) => !existing.some((old) => old.idea_id === r.id))
            .length >
        1000
      )
        throw new AppError(
          "SEMANTIC_CAPACITY",
          "The cache changed and exceeds its approved capacity.",
          409,
        );
      if (!c.refresh)
        for (const record of records) {
          const old = existing.find((r) => r.idea_id === record.id);
          if (old) {
            try {
              const checked = await this.cache.checked(old);
              if (
                checked.input_hash === record.inputHash &&
                checked.dimensions === this.config.dimensions
              )
                throw new AppError(
                  "SEMANTIC_INDEX_CURRENT",
                  "Some approved inputs were indexed by another request. Review the remaining work again.",
                  409,
                );
            } catch (error) {
              if (error instanceof AppError) throw error;
            }
          }
        }
      const generated = this.confirmed(
        await this.provider.embed(
          records.map((r) => r.input),
          signal,
        ),
        records.length,
      );
      // Recheck every original before persisting any derived vector.
      if ((await manifestHash(await this.records(c))) !== context.manifest)
        throw new AppError(
          "STALE_IDEA",
          "An idea changed during embedding. No vector from this batch was stored.",
          409,
        );
      for (let n = 0; n < records.length; n++)
        await this.cache.put(
          actor,
          context.profile,
          records[n],
          generated.model,
          generated.vectors[n],
          op.id,
          this.config.cacheSeconds,
        );
      if (
        !(await this.operations.finishRunning(op.id, "done", context.manifest))
      )
        throw new AppError(
          "SEMANTIC_CANCELLED",
          "This derived operation was cancelled.",
          409,
        );
      return {
        status: "done",
        indexed: records.map((r) => r.id),
        model: generated.model,
        dimensions: this.config.dimensions,
        tokens: generated.tokens,
      };
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
  async query(
    input: QueryCommand,
    token: string,
    actor: string,
    signal?: AbortSignal,
  ) {
    const c = this.normalizedQuery(input),
      op = await this.operations.read(token, actor);
    if (
      op.expected_revision !== (await this.context()) ||
      op.target !== "semantic-query:" + (await digest(actor))
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "Embedding configuration changed. Review query transmission again.",
        409,
      );
    await this.claim(c, token, actor, "semantic-query");
    try {
      await this.cache.purgeExpired(actor);
      const rows = await this.cache.rows(
        actor,
        await embeddingProfileHash(this.config),
      );
      if (!rows.length)
        throw new AppError(
          "SEMANTIC_INDEX_EMPTY",
          "No active vectors remain. Rebuild selected records before searching.",
          409,
        );
      const generated = this.confirmed(
          await this.provider.embed([c.query], signal),
          1,
        ),
        compatible = rows.filter(
          (r) =>
            r.model === generated.model &&
            r.dimensions === this.config.dimensions,
        );
      if (!compatible.length)
        throw new AppError(
          "SEMANTIC_MODEL_CHANGED",
          "No indexed vectors match the returned model. Explicitly regenerate with the current pinned deployment/version.",
          409,
        );
      const authoritative = await this.repository.list({
          ...c.filters,
          sort: "title",
        }),
        ideas = new Map(
          authoritative.filter((i) => !i.canonicalIdeaId).map((i) => [i.id, i]),
        );
      const indexedIds = new Set(rows.map((row) => row.idea_id));
      const excluded = {
          notIndexed: [...ideas.keys()].filter((id) => !indexedIds.has(id))
            .length,
          missingOrFiltered: 0,
          changed: 0,
          invalid: 0,
          incompatible: rows.length - compatible.length,
        },
        matches = [];
      for (const row of compatible) {
        const idea = ideas.get(row.idea_id);
        if (row.expires_at <= Date.now()) {
          excluded.invalid++;
          continue;
        }
        if (!idea) {
          excluded.missingOrFiltered++;
          continue;
        }
        try {
          const checked = await this.cache.checked(row),
            current = await semanticInput(idea, checked.fields, [
              this.config.key,
              ...this.secrets,
            ]);
          if (current.hash !== checked.input_hash) {
            excluded.changed++;
            continue;
          }
          const similarity = cosine(generated.vectors[0], checked.values);
          if (similarity >= c.threshold)
            matches.push({
              idea,
              similarity,
              indexedFields: checked.fields,
              cachedAt: new Date(checked.updated_at).toISOString(),
            });
        } catch {
          excluded.invalid++;
        }
      }
      matches.sort(
        (a, b) =>
          b.similarity - a.similarity || a.idea.id.localeCompare(b.idea.id),
      );
      const activeReference = await this.cache.snapshots.reference(actor);
      if (activeReference)
        await this.cache.rows(actor, await embeddingProfileHash(this.config));
      const result = {
        snapshotId: activeReference?.snapshot_id ?? null,
        query: c.query,
        matches: matches.slice(0, c.limit),
        excluded,
        indexed: rows.length,
        model: generated.model,
        inputVersion,
        message:
          "Only current, compatible cached records were searched. Similarity suggests a connection; duplicate classification and merges require separate review.",
      };
      if (
        !(await this.operations.finishRunning(
          op.id,
          "done",
          await digest(JSON.stringify(result)),
        ))
      )
        throw new AppError(
          "SEMANTIC_CANCELLED",
          "This query operation was cancelled.",
          409,
        );
      return result;
    } catch (error) {
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
}
