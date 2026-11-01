"use client";
import { SnapshotWorkbench } from "./snapshots";
import Link from "@/components/navigation-link";
import { useEffect, useRef, useState } from "react";
import { useResource, requestData } from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
import { IdeaCard } from "@/components/ideas/idea-card";
import { RecentSaves } from "@/components/ideas/operations";
import {
  categories,
  statuses,
  systems,
  efforts,
  fieldLabels,
  type Idea,
} from "@/lib/ideas/domain";
import {
  semanticFields,
  indexCommandSchema,
  queryCommandSchema,
  type IndexCommand,
  type QueryCommand,
} from "@/lib/intelligence/semantic-model";
type Kind = "index" | "query" | "clear";
type Receipt = {
  kind: Kind;
  approvalToken: string;
  expiresAt: string;
  command: IndexCommand | QueryCommand | { scope: "all-my-semantic-vectors" };
  changes: { field: string; before: string; after: string }[];
};
type Profile = {
  snapshotCount?: number;
  activeSnapshotId?: string | null;
  activeUnavailable?: boolean;
  enabled: boolean;
  endpoint?: string;
  deployment?: string;
  versionLabel?: string;
  dimensions?: number;
  cacheSeconds?: number;
  cache: { total: number; usable: number | null };
};
type SearchResult = {
  snapshotId?: string | null;
  query: string;
  matches: {
    idea: Idea;
    similarity: number;
    indexedFields: string[];
    cachedAt: string;
  }[];
  excluded: {
    missingOrFiltered: number;
    changed: number;
    invalid: number;
    incompatible: number;
    notIndexed?: number;
  };
  indexed: number;
  model: string;
  message: string;
};
export function SemanticWorkspace() {
  const ideas = useResource<Idea[]>("/api/ideas"),
    profile = useResource<Profile>("/api/semantic/status");
  const [chosen, setChosen] = useState<Record<string, string>>({}),
    [fields, setFields] = useState<(typeof semanticFields)[number][]>([]),
    [refreshVectors, setRefreshVectors] = useState(false),
    [selectionFilter, setSelectionFilter] = useState(""),
    [visible, setVisible] = useState(30);
  const [query, setQuery] = useState(""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [source, setSource] = useState(""),
    [effort, setEffort] = useState(""),
    [minScore, setMinScore] = useState(""),
    [threshold, setThreshold] = useState("0.5"),
    [limit, setLimit] = useState("10");
  const [receipt, setReceipt] = useState<Receipt | null>(null),
    [operationStatus, setOperationStatus] = useState(""),
    [sent, setSent] = useState(false),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [results, setResults] = useState<SearchResult | null>(null);
  const controller = useRef<AbortController | null>(null),
    epoch = useRef(0),
    running = useRef(false),
    reviewHeading = useRef<HTMLHeadingElement | null>(null);
  useEffect(
    () => () => {
      epoch.current++;
      controller.current?.abort();
    },
    [],
  );
  useEffect(() => {
    if (receipt) reviewHeading.current?.focus();
  }, [receipt]);
  const [snapshotReview, setSnapshotReview] = useState(false);
  const locked = !!receipt || !!busy || snapshotReview,
    terminal = ["done", "failed", "cancelled"].includes(operationStatus),
    enabled = profile.data?.enabled === true;
  const available = (ideas.data ?? []).filter((i) => !i.canonicalIdeaId),
    filtered = available.filter((i) =>
      (i.title + " " + i.summary)
        .toLowerCase()
        .includes(selectionFilter.toLowerCase()),
    );
  async function prepare(kind: Kind) {
    if (running.current || receipt) return;
    let command: Receipt["command"];
    try {
      command =
        kind === "index"
          ? indexCommandSchema.parse({
              records: Object.entries(chosen).map(([id, expectedRevision]) => ({
                id,
                expectedRevision,
              })),
              fields,
              refresh: refreshVectors,
            })
          : kind === "query"
            ? queryCommandSchema.parse({
                query,
                filters: {
                  category: category || undefined,
                  status: status || undefined,
                  source: source || undefined,
                  effort: effort || undefined,
                  minScore: minScore ? Number(minScore) : undefined,
                },
                threshold: Number(threshold),
                limit: Number(limit),
              })
            : { scope: "all-my-semantic-vectors" };
    } catch {
      setError(
        kind === "index"
          ? "Choose 1–20 current ideas and at least one description field."
          : "Enter a query, a cosine threshold from −1 to 1, and a result limit from 1 to 20.",
      );
      return;
    }
    running.current = true;
    setBusy("preparing");
    setError("");
    setMessage("");
    const current = ++epoch.current;
    try {
      const reviewed = await requestData<Omit<Receipt, "kind">>(
        "/api/semantic/" + kind + "/prepare",
        { method: "POST", body: JSON.stringify(command) },
      );
      if (current !== epoch.current) return;
      setReceipt({ ...reviewed, kind });
      setSent(false);
      setOperationStatus("pending");
    } catch (e) {
      if (current === epoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "This request could not be reviewed.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  async function send() {
    if (!receipt || running.current || sent) return;
    running.current = true;
    setBusy("sending");
    setSent(true);
    setOperationStatus("unknown");
    setError("");
    setMessage("");
    if (receipt.kind === "query") setResults(null);
    const current = ++epoch.current,
      abort = new AbortController();
    controller.current = abort;
    try {
      const result = await requestData<SearchResult>(
        "/api/semantic/" + receipt.kind + "/commit",
        {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify({
            approvalToken: receipt.approvalToken,
            command: receipt.command,
          }),
        },
      );
      if (current !== epoch.current) return;
      setOperationStatus("done");
      if (receipt.kind === "query") {
        setResults(result);
        setMessage("Search complete. Results stay in this page’s memory.");
      } else if (receipt.kind === "index")
        setMessage(
          "Selected idea vectors are ready. Review a query to search them.",
        );
      else {
        setResults(null);
        setMessage(
          "Your derived vectors were cleared. Canonical Notion content and scores are preserved.",
        );
      }
      profile.refresh();
    } catch (e) {
      if (current === epoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "No completion was confirmed. Check status before reviewing a new request.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy("");
        controller.current = null;
      }
    }
  }
  async function inspect(cancel = false) {
    if (
      !receipt ||
      busy === "cancelling" ||
      busy === "checking" ||
      busy === "preparing"
    )
      return;
    if (!cancel && running.current) return;
    const current = ++epoch.current;
    controller.current?.abort();
    controller.current = null;
    running.current = true;
    setBusy(cancel ? "cancelling" : "checking");
    setError("");
    try {
      const state = await requestData<{ status: string; message: string }>(
        cancel ? "/api/semantic/cancel" : "/api/semantic/status",
        {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        },
      );
      if (current !== epoch.current) return;
      setOperationStatus(state.status);
      setMessage(state.message);
      if (cancel) setSent(true);
      profile.refresh();
    } catch (e) {
      if (current === epoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "The operation state could not be checked. Keep this review and check again.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  function closeReview() {
    if (!terminal || running.current) return;
    epoch.current++;
    setReceipt(null);
    setSent(false);
    setOperationStatus("");
    setError("");
  }
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">FIND CONNECTIONS IN YOUR COLLECTION</div>
          <h1>
            Semantic search<span>.</span>
          </h1>
          <p>
            Search selected idea descriptions by meaning, with current Notion
            records behind every match.
          </p>
        </div>
        <Link className="site-secondary" href="/ideas">
          Back to explorer
        </Link>
      </div>
      <p className="notice">
        Choose the records and fields to index, review exactly what leaves this
        workspace, then approve one request. Similarity is a clue for review.
        Scores, relationships and merges require their own approvals.
      </p>
      <section className="panel prose-panel mt-panel">
        <div className="section-heading">
          <h2>Embedding connection</h2>
          <button
            className="site-secondary"
            disabled={locked || profile.loading}
            onClick={profile.refresh}
          >
            Refresh cache status
          </button>
        </div>
        {profile.error ? (
          <Failure error={profile.error} retry={profile.refresh} />
        ) : !profile.data ? (
          <Loading />
        ) : (
          <>
            <p>
              {enabled
                ? "Configured: " +
                  profile.data.deployment +
                  " · " +
                  profile.data.versionLabel +
                  " · " +
                  profile.data.dimensions +
                  " dimensions"
                : "Semantic model requests are disabled. Configure the embedding connection in protected server settings to enable indexing and search."}
            </p>
            <p>
              {profile.data.cache.total} retained vectors across your profiles.
              Search covers only compatible, unexpired vectors whose selected
              descriptions still match Notion.
            </p>
            {enabled && (
              <p className="subtle-note">
                Vectors expire after{" "}
                {Math.round((profile.data.cacheSeconds ?? 0) / 3600)} hours and
                are removed on cache access. Changes to the pinned
                deployment/version require explicit regeneration.
              </p>
            )}
          </>
        )}
      </section>
      <SnapshotWorkbench
        ideas={available}
        enabled={enabled}
        disabled={!!receipt || !!busy}
        onReviewState={setSnapshotReview}
        onChange={profile.refresh}
      />
      <section className="panel prose-panel mt-panel">
        <h2>Selected-record indexing</h2>
        <p>
          Choose up to 20 ideas per request. Nothing is selected automatically.
          Only the chosen description fields are transmitted; scores and source
          histories are excluded. Once a full snapshot governs search, use
          complete rebuilds above.
        </p>
        {ideas.error ? (
          <Failure error={ideas.error} retry={ideas.refresh} />
        ) : !ideas.data ? (
          <Loading />
        ) : (
          <>
            <fieldset disabled={locked || !!profile.data?.activeSnapshotId}>
              <legend>
                Idea selection · {Object.keys(chosen).length} of 20
              </legend>
              <label className="form-field">
                Filter available ideas
                <input
                  aria-label="Filter ideas to index"
                  value={selectionFilter}
                  onChange={(e) => {
                    setSelectionFilter(e.target.value);
                    setVisible(30);
                  }}
                  placeholder="Title or summary"
                />
              </label>
              <div className="semantic-selection">
                {filtered.slice(0, visible).map((i) => (
                  <label className="semantic-choice" key={i.id}>
                    <input
                      type="checkbox"
                      checked={!!chosen[i.id]}
                      disabled={
                        !chosen[i.id] && Object.keys(chosen).length >= 20
                      }
                      onChange={(e) =>
                        setChosen((previous) => {
                          const next = { ...previous };
                          if (e.target.checked) next[i.id] = i.revision;
                          else delete next[i.id];
                          return next;
                        })
                      }
                    />
                    <span>
                      <strong>{i.title}</strong>
                      <small>{i.summary}</small>
                    </span>
                  </label>
                ))}
              </div>
              {!filtered.length && <p>No canonical ideas match this filter.</p>}
              {filtered.length > visible && (
                <button
                  className="site-secondary"
                  onClick={() => setVisible((v) => v + 30)}
                >
                  Show 30 more ideas
                </button>
              )}
              <div className="action-row">
                <button
                  className="site-secondary"
                  onClick={() => setChosen({})}
                >
                  Clear selection
                </button>
                <button
                  className="site-secondary"
                  onClick={() => {
                    setChosen({});
                    ideas.refresh();
                  }}
                >
                  Reload current ideas
                </button>
              </div>
            </fieldset>
            <fieldset disabled={locked || !!profile.data?.activeSnapshotId}>
              <legend>Description fields</legend>
              <div className="semantic-fields">
                {semanticFields.map((field) => (
                  <label key={field}>
                    <input
                      type="checkbox"
                      checked={fields.includes(field)}
                      onChange={(e) =>
                        setFields((previous) =>
                          e.target.checked
                            ? [...previous, field]
                            : previous.filter((f) => f !== field),
                        )
                      }
                    />
                    {fieldLabels[field]}
                  </label>
                ))}
              </div>
              <label className="semantic-choice">
                <input
                  type="checkbox"
                  checked={refreshVectors}
                  onChange={(e) => setRefreshVectors(e.target.checked)}
                />
                <span>
                  Explicitly regenerate selected vectors, including current
                  inputs
                </span>
              </label>
            </fieldset>
            <button
              className="site-primary"
              disabled={
                locked ||
                !enabled ||
                !!profile.data?.activeSnapshotId ||
                !Object.keys(chosen).length ||
                !fields.length
              }
              onClick={() => prepare("index")}
            >
              Review indexing transmission
            </button>
          </>
        )}
      </section>
      <section className="panel prose-panel mt-panel">
        <h2>Search by meaning</h2>
        <p>
          Only the query is sent for an embedding. Current filters are applied
          in Notion; an incomplete index can omit relevant ideas.
        </p>
        <fieldset disabled={locked}>
          <legend>Query and current-record filters</legend>
          <label className="form-field">
            Semantic query
            <textarea
              aria-label="Semantic query"
              maxLength={2000}
              rows={3}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="What kind of idea are you looking for?"
            />
          </label>
          <div className="filter-bar">
            {[
              {
                name: "Category",
                value: category,
                set: setCategory,
                options: categories,
              },
              {
                name: "Status",
                value: status,
                set: setStatus,
                options: statuses,
              },
              {
                name: "Source",
                value: source,
                set: setSource,
                options: systems,
              },
              {
                name: "Effort",
                value: effort,
                set: setEffort,
                options: efforts,
              },
            ].map((f) => (
              <label key={f.name}>
                {f.name}
                <select
                  aria-label={"Semantic " + f.name.toLowerCase()}
                  value={f.value}
                  onChange={(e) => f.set(e.target.value)}
                >
                  <option value="">Any {f.name.toLowerCase()}</option>
                  {f.options.map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="form-grid">
            <label className="form-field">
              Minimum canonical score
              <input
                aria-label="Minimum canonical score"
                type="number"
                min="0"
                max="100"
                value={minScore}
                onChange={(e) => setMinScore(e.target.value)}
                placeholder="Any score"
              />
            </label>
            <label className="form-field">
              Minimum cosine similarity
              <input
                aria-label="Minimum cosine similarity"
                type="number"
                min="-1"
                max="1"
                step="0.05"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
              />
            </label>
            <label className="form-field">
              Maximum results
              <input
                aria-label="Maximum semantic results"
                type="number"
                min="1"
                max="20"
                value={limit}
                onChange={(e) => setLimit(e.target.value)}
              />
            </label>
          </div>
        </fieldset>
        <button
          className="site-primary"
          disabled={locked || !enabled || !query.trim()}
          onClick={() => prepare("query")}
        >
          Review query transmission
        </button>
      </section>
      <section className="panel prose-panel mt-panel">
        <h2>Derived cache</h2>
        <p>
          Clearing removes your vectors, snapshot manifests and active search
          pointer across model profiles. Rebuild from selected Notion records
          when needed. Clearing works even when the model connection is
          disabled.
        </p>
        <button
          className="site-secondary"
          disabled={
            locked ||
            !(
              profile.data?.cache.total ||
              profile.data?.snapshotCount ||
              profile.data?.activeSnapshotId
            )
          }
          onClick={() => prepare("clear")}
        >
          Review clearing derived vectors
        </button>
      </section>
      {receipt && (
        <section
          className="panel prose-panel mt-panel semantic-review"
          aria-label="Semantic transmission review"
        >
          <h2 ref={reviewHeading} tabIndex={-1}>
            {receipt.kind === "clear"
              ? "Review derived cache clearing"
              : "Review selected transmission"}
          </h2>
          <p>
            Approval expires {new Date(receipt.expiresAt).toLocaleTimeString()}.
            Operation: {operationStatus}.
          </p>
          {receipt.changes.map((change, i) => (
            <div className="diff-row" key={i}>
              <strong>{change.field}</strong>
              {change.before && (
                <p className="preserve-text">{change.before}</p>
              )}
              <p className="preserve-text">{change.after}</p>
            </div>
          ))}
          <div className="action-row">
            {!sent && (
              <button className="site-primary" disabled={!!busy} onClick={send}>
                {receipt.kind === "clear"
                  ? "Approve clearing derived vectors"
                  : "Approve and send selected content"}
              </button>
            )}
            {sent && !terminal && (
              <button
                className="site-secondary"
                disabled={!!busy}
                onClick={() => inspect()}
              >
                Check request status
              </button>
            )}
            {!terminal && (
              <button
                className="site-secondary"
                disabled={!!busy && busy !== "sending"}
                onClick={() => inspect(true)}
              >
                {busy === "cancelling"
                  ? "Cancelling…"
                  : "Cancel derived operation"}
              </button>
            )}
            {terminal && (
              <button
                className="site-secondary"
                disabled={!!busy}
                onClick={closeReview}
              >
                Start a new review
              </button>
            )}
          </div>
          <p className="subtle-note">
            Cancellation prevents later cache writes and releases
            derived-operation locks. The provider may already have processed a
            dispatched request; charges and verified partial vectors and already
            committed derived changes can remain. No model request is replayed
            by checking status.
          </p>
        </section>
      )}
      {busy && (
        <p role="status">
          {busy === "sending"
            ? "Processing the approved request…"
            : busy === "preparing"
              ? "Preparing the exact review…"
              : busy === "cancelling"
                ? "Cancelling the derived operation…"
                : "Checking the operation…"}
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {results && (
        <section className="mt-panel" aria-label="Semantic search results">
          <h2>Matches for “{results.query}”</h2>
          <p>{results.message}</p>
          <p className="subtle-note">
            {results.snapshotId
              ? "Snapshot: " + results.snapshotId
              : "Selected-record index"}
            . Current filtered records without vectors:{" "}
            {results.excluded.notIndexed ?? 0}.
          </p>
          <p className="subtle-note">
            {results.indexed} cached vectors considered · model {results.model}.
            Excluded: {results.excluded.missingOrFiltered} missing, superseded
            or filtered; {results.excluded.changed} changed;{" "}
            {results.excluded.invalid} invalid; {results.excluded.incompatible}{" "}
            incompatible. Cosine similarity ranges from −1 to 1 and is not a
            probability.
          </p>
          {!results.matches.length ? (
            <div className="panel prose-panel">
              <p>
                No current compatible matches met the threshold. Review index
                coverage, fields, filters or threshold before another request.
              </p>
            </div>
          ) : (
            <div className="explorer-grid">
              {results.matches.map((match) => (
                <div key={match.idea.id}>
                  <p>
                    <strong>
                      Cosine similarity {match.similarity.toFixed(3)}
                    </strong>
                  </p>
                  <IdeaCard idea={match.idea} />
                  <p className="subtle-note">
                    Indexed{" "}
                    {match.indexedFields
                      .map(
                        (f) => fieldLabels[f as keyof typeof fieldLabels] ?? f,
                      )
                      .join(", ")}{" "}
                    · {new Date(match.cachedAt).toLocaleString()}
                  </p>
                  {match.idea.url && (
                    <a
                      className="text-link"
                      href={match.idea.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Open canonical Notion record
                    </a>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      )}
      <RecentSaves />
    </div>
  );
}
