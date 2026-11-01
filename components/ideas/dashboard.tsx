"use client";
import Link from "@/components/navigation-link";
import {
  Lightbulb,
  Inbox,
  TrendingUp,
  Zap,
  Plus,
  Sparkles,
  RefreshCw,
  ArrowRight,
  RotateCcw,
} from "lucide-react";
import {
  categories,
  statuses,
  type Idea,
  type Review,
} from "@/lib/ideas/domain";
import { useResource } from "./use-resource";
import { Failure, Loading } from "./states";
import { IdeaCard } from "./idea-card";
export function Dashboard() {
  const { data, error, loading, refresh, stale } = useResource<{
    ideas: Idea[];
    reviews: Review[];
    reviewUnavailable: boolean;
  }>("/api/dashboard");
  const ideas = data?.ideas ?? [],
    reviews = data?.reviews ?? [];
  const recent = [...ideas]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 4);
  const focus = ideas
    .filter((i) => !["Completed", "Parked", "Archived"].includes(i.status))
    .slice(0, 3);
  const revisit = ideas
    .filter((i) => i.status === "Parked")
    .sort((a, b) => (a.lastReviewed ?? "").localeCompare(b.lastReviewed ?? ""))
    .slice(0, 2);
  return (
    <div className="page dashboard">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR IDEAS, CONNECTED</div>
          <h1>
            A little space for big ideas<span>.</span>
          </h1>
          <p>Capture the sparks. Connect the dots. Decide what’s next.</p>
        </div>
        <div className="action-row">
          <button
            className="site-secondary"
            onClick={refresh}
            disabled={loading}
            aria-label="Refresh dashboard"
          >
            <RefreshCw size={15} />
          </button>
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
          <div className="stats-grid">
            {[
              {
                label: "Total ideas",
                value: ideas.length,
                icon: Lightbulb,
                color: "mint",
                note: "Canonical Notion records",
              },
              {
                label: "Needs a closer look",
                value: data.reviewUnavailable ? null : reviews.length,
                icon: Inbox,
                color: "sand",
                note: data.reviewUnavailable
                  ? "Review queue unavailable"
                  : "Pending review decisions",
              },
              {
                label: "High potential",
                value: ideas.filter((i) => (i.priorityScore ?? -1) >= 80)
                  .length,
                icon: TrendingUp,
                color: "lilac",
                note: "Potential score 80 or higher",
              },
              {
                label: "In motion",
                value: ideas.filter((i) => i.status === "Active").length,
                icon: Zap,
                color: "blue",
                note: "From idea to reality",
              },
            ].map((s) => (
              <div className="stat-card" key={s.label}>
                <div className="stat-heading">
                  {s.label}
                  <span className={"stat-icon " + s.color}>
                    <s.icon size={17} />
                  </span>
                </div>
                <strong>
                  {s.value === null ? "—" : String(s.value).padStart(2, "0")}
                </strong>
                <small>{s.note}</small>
              </div>
            ))}
          </div>
          {!ideas.length ? (
            <div className="panel empty-state">
              <Lightbulb size={28} />
              <h2>Your first spark belongs here.</h2>
              <p>
                The Notion connection is working. Capture an idea to start your
                collection.
              </p>
              <Link className="site-primary" href="/ideas/new">
                Capture your first idea
              </Link>
            </div>
          ) : (
            <>
              <section>
                <div className="section-heading">
                  <div>
                    <h2>
                      <Sparkles size={18} />
                      Worth your attention
                    </h2>
                    <p>
                      Highest potential among ideas still in play. Unrated ideas
                      follow scored ones.
                    </p>
                  </div>
                  <Link href="/ideas">
                    Explore ideas <ArrowRight size={15} />
                  </Link>
                </div>
                <div className="focus-grid">
                  {focus.map((i) => (
                    <IdeaCard key={i.id} idea={i} />
                  ))}
                </div>
                {!focus.length && (
                  <p className="subtle-note">
                    No ideas are currently in an active discovery or development
                    stage.
                  </p>
                )}
                <p className="recommendation-note">
                  Potential, effort and readiness are separate. This ranking
                  uses saved scores; no AI evaluation was run.
                </p>
              </section>
              <div className="dashboard-columns">
                <section className="panel recent-panel">
                  <div className="section-heading">
                    <div>
                      <h2>Fresh in the lab</h2>
                      <p>Recently captured possibilities.</p>
                    </div>
                    <Link href="/ideas?sort=recent">
                      View all <ArrowRight size={14} />
                    </Link>
                  </div>
                  {recent.map((i) => (
                    <Link
                      className="recent-row"
                      key={i.id}
                      href={"/ideas/" + i.id}
                    >
                      <div>
                        <strong>{i.title || "Untitled record"}</strong>
                        <small>{i.category}</small>
                      </div>
                      <span className="status-text">{i.status}</span>
                      <span className="table-score">
                        {i.priorityScore ?? "—"}
                      </span>
                    </Link>
                  ))}
                </section>
                <section className="panel mix-panel">
                  <div className="section-heading">
                    <div>
                      <h2>Your idea landscape</h2>
                      <p>From your canonical collection.</p>
                    </div>
                  </div>
                  <div className="distribution-bar">
                    {categories.map((c, n) => (
                      <span
                        className={"distribution-" + n}
                        key={c}
                        style={{
                          flex: ideas.filter((i) => i.category === c).length,
                        }}
                      />
                    ))}
                  </div>
                  <div className="category-legend">
                    {categories.map((c, n) => (
                      <div key={c}>
                        <span>
                          <i className={"distribution-" + n} />
                          {c}
                        </span>
                        <strong>
                          {ideas.filter((i) => i.category === c).length}
                        </strong>
                      </div>
                    ))}
                  </div>
                  <div className="status-summary">
                    {statuses
                      .filter((s) => ideas.some((i) => i.status === s))
                      .map((s) => (
                        <span key={s}>
                          {s}{" "}
                          <strong>
                            {ideas.filter((i) => i.status === s).length}
                          </strong>
                        </span>
                      ))}
                  </div>
                </section>
              </div>
            </>
          )}
          <div className="bottom-grid">
            <section className="panel prose-panel">
              <h2>Potential connections</h2>
              {data.reviewUnavailable ? (
                <p>
                  The review queue could not be loaded. Refresh to try again.
                </p>
              ) : !reviews.length ? (
                <p>No pending reviews were found.</p>
              ) : (
                reviews.slice(0, 2).map((r) => (
                  <div key={r.id} className="related-link">
                    <span>{r.title || r.type}</span>
                    <Link href="/review">
                      Review <ArrowRight size={14} />
                    </Link>
                  </div>
                ))
              )}
              <Link className="text-link" href="/review">
                Open review center <ArrowRight size={14} />
              </Link>
            </section>
            <section className="panel prose-panel">
              <h2>
                <RotateCcw size={18} />
                Worth another look
              </h2>
              {revisit.length ? (
                revisit.map((i) => (
                  <Link
                    className="related-link"
                    key={i.id}
                    href={"/ideas/" + i.id}
                  >
                    {i.title}
                    <ArrowRight size={14} />
                  </Link>
                ))
              ) : (
                <p>No parked ideas to revisit yet.</p>
              )}
            </section>
          </div>
          <p className="subtle-note" role="status">
            {loading
              ? "Refreshing…"
              : "Loaded from Notion. Refresh to see changes made elsewhere."}
          </p>
        </>
      )}
    </div>
  );
}
