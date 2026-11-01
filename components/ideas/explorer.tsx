"use client";
import Link from "@/components/navigation-link";
import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { Search, Grid2X2, List, Plus, RefreshCw } from "lucide-react";
import {
  categories,
  statuses,
  systems,
  efforts,
  filterIdeas,
  filtersSchema,
  type Idea,
} from "@/lib/ideas/domain";
import { IdeaCard } from "./idea-card";
import { useResource } from "./use-resource";
import { Failure, Loading } from "./states";
export function Explorer() {
  const params = useSearchParams(),
    [query, setQuery] = useState(params.get("q") ?? ""),
    [category, setCategory] = useState(""),
    [status, setStatus] = useState(""),
    [source, setSource] = useState(""),
    [effort, setEffort] = useState(""),
    [minScore, setMinScore] = useState(params.get("minScore") ?? ""),
    [sort, setSort] = useState(params.get("sort") ?? "score"),
    [view, setView] = useState("cards");
  const { data, error, loading, refresh, stale } =
    useResource<Idea[]>("/api/ideas");
  const filter = filtersSchema.safeParse({
    query,
    category: category || undefined,
    status: status || undefined,
    source: source || undefined,
    effort: effort || undefined,
    minScore: minScore ? Number(minScore) : undefined,
    sort,
  });
  const filtered = filterIdeas(
    data ?? [],
    filter.success ? filter.data : { sort: "score" },
  );
  function reset() {
    setQuery("");
    setCategory("");
    setStatus("");
    setSource("");
    setEffort("");
    setMinScore("");
  }
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">A COLLECTION OF POSSIBILITIES</div>
          <h1>
            Idea explorer<span>.</span>
          </h1>
          <p>Find a familiar spark. Discover an unexpected connection.</p>
        </div>
        <div className="action-row">
          <button
            className="site-secondary"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh ideas"
          >
            <RefreshCw size={15} />
          </button>
          <Link className="site-secondary" href="/ideas/semantic">
            Semantic search
          </Link>
          <Link className="site-primary" href="/ideas/new">
            <Plus size={15} />
            Capture an idea
          </Link>
        </div>
      </div>
      {error ? (
        <Failure error={error} retry={refresh} stale={stale} />
      ) : !data ? (
        <Loading />
      ) : (
        <>
          <div className="explorer-toolbar">
            <div className="search-field">
              <Search size={18} />
              <input
                aria-label="Search ideas"
                placeholder="Search titles, problems, or solutions…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="view-toggle">
              <button
                aria-label="Card view"
                aria-pressed={view === "cards"}
                onClick={() => setView("cards")}
              >
                <Grid2X2 size={17} />
              </button>
              <button
                aria-label="Table view"
                aria-pressed={view === "table"}
                onClick={() => setView("table")}
              >
                <List size={17} />
              </button>
            </div>
          </div>
          <div className="filter-bar">
            {[
              {
                label: "Category",
                value: category,
                set: setCategory,
                all: "All categories",
                options: categories,
              },
              {
                label: "Status",
                value: status,
                set: setStatus,
                all: "All statuses",
                options: statuses,
              },
              {
                label: "Source",
                value: source,
                set: setSource,
                all: "All sources",
                options: systems,
              },
              {
                label: "Effort",
                value: effort,
                set: setEffort,
                all: "Any effort",
                options: efforts,
              },
            ].map((f) => (
              <select
                key={f.label}
                aria-label={f.label}
                value={f.value}
                onChange={(e) => f.set(e.target.value)}
              >
                <option value="">{f.all}</option>
                {f.options.map((v) => (
                  <option key={v}>{v}</option>
                ))}
              </select>
            ))}
            <select
              aria-label="Minimum score"
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
            >
              <option value="">Any score</option>
              <option value="80">80+ potential</option>
              <option value="60">60+ potential</option>
            </select>
            <button className="clear-filters" onClick={reset}>
              Reset filters
            </button>
          </div>
          <div className="result-heading">
            <span aria-live="polite">
              {filtered.length} of {data.length} ideas
            </span>
            <label>
              Sort by{" "}
              <select
                aria-label="Sort ideas"
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                <option value="score">Highest potential</option>
                <option value="recent">Recently captured</option>
                <option value="title">Title A–Z</option>
              </select>
            </label>
          </div>
          {!filtered.length ? (
            <div className="panel empty-state">
              <Search size={28} />
              <h2>
                {data.length
                  ? "No ideas match these filters."
                  : "Your collection is ready for its first idea."}
              </h2>
              <p>
                {data.length
                  ? "Try a broader search or clear your filters."
                  : "Capture a meaningful idea and approve it to save it in Notion."}
              </p>
              <button className="site-secondary" onClick={reset}>
                Clear all filters
              </button>
            </div>
          ) : view === "cards" ? (
            <div className="explorer-grid">
              {filtered.map((i) => (
                <IdeaCard key={i.id} idea={i} />
              ))}
            </div>
          ) : (
            <div className="table-scroll">
              <table className="ideas-table">
                <thead>
                  <tr>
                    <th>Idea</th>
                    <th>Category</th>
                    <th>Status</th>
                    <th>Effort</th>
                    <th>Potential</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((i) => (
                    <tr key={i.id}>
                      <td>
                        <Link href={"/ideas/" + i.id}>
                          {i.title || "Untitled record"}
                        </Link>
                        <small>
                          {i.sources.map((s) => s.system).join(", ") ||
                            "No linked source"}
                        </small>
                      </td>
                      <td>{i.category}</td>
                      <td>
                        <span className={"badge " + i.status.toLowerCase()}>
                          {i.status}
                        </span>
                      </td>
                      <td>{i.effort}</td>
                      <td>{i.priorityScore ?? "Unrated"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="subtle-note">
            {loading
              ? "Refreshing…"
              : "Keyword search over loaded Notion records. Use Semantic search to review selected-content indexing and search by meaning."}
          </p>
        </>
      )}
    </div>
  );
}
