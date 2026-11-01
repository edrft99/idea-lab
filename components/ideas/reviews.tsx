"use client";
import Link from "@/components/navigation-link";
import { RefreshCw, ShieldCheck } from "lucide-react";
import type { Review } from "@/lib/ideas/domain";
import { useResource } from "./use-resource";
import { Failure, Loading } from "./states";
export function Reviews() {
  const { data, error, loading, refresh } =
    useResource<Review[]>("/api/reviews");
  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR JUDGMENT, AT THE CENTER</div>
          <h1>
            A closer look<span>.</span>
          </h1>
          <p>Pending reviews from the authoritative Notion queue.</p>
          <Link className="text-link" href="/review/compare">
            Compare two canonical ideas
          </Link>
          <Link className="text-link mt-button" href="/review/merge">
            Review an explicit merge
          </Link>
        </div>
        <button className="site-secondary" onClick={refresh} disabled={loading}>
          <RefreshCw size={14} />
          Refresh
        </button>
      </div>
      <div className="notice">
        <ShieldCheck size={18} />
        Compare saved candidates and record an explicit relationship decision.
        Extraction/evaluation proposals and merge execution are separate
        workflows.
      </div>
      {error ? (
        <Failure error={error} retry={refresh} />
      ) : !data ? (
        <Loading />
      ) : !data.length ? (
        <div className="panel empty-state">
          <h2>Nothing waiting on a decision.</h2>
          <p>No pending review records were found.</p>
        </div>
      ) : (
        <div className="review-list">
          {data.map((r) => (
            <section className="panel prose-panel" key={r.id}>
              <div className="section-heading">
                <h2>{r.title || r.type || "Review"}</h2>
                <span className="badge">{r.status}</span>
              </div>
              <p className="preserve-text">
                {r.reasoning || "No reasoning recorded."}
              </p>
              <div className="review-meta">
                <span>
                  Recommendation: {r.recommendation ?? "Not recorded"}
                </span>
                <span>
                  Similarity:{" "}
                  {r.similarity === null
                    ? "Unrated"
                    : Math.round(r.similarity * 100) + "%"}
                </span>
              </div>
              <div className="action-row mt-button">
                {r.workflow === "assessment" && (
                  <Link
                    className="site-primary"
                    href={"/review/assessments/" + r.id}
                  >
                    Review saved assessment
                  </Link>
                )}
                {r.workflow === "extraction" && (
                  <Link
                    className="site-primary"
                    href={"/review/proposals/" + r.id}
                  >
                    Review saved extraction
                  </Link>
                )}
                {r.candidateIdeaId && r.matchingIdeaId && (
                  <Link className="site-primary" href={"/review/" + r.id}>
                    Compare and decide
                  </Link>
                )}
                {r.candidateIdeaId && (
                  <Link
                    className="site-secondary"
                    href={"/ideas/" + r.candidateIdeaId}
                  >
                    Open candidate
                  </Link>
                )}
                {r.matchingIdeaId && (
                  <Link
                    className="site-secondary"
                    href={"/ideas/" + r.matchingIdeaId}
                  >
                    Open possible match
                  </Link>
                )}
                {r.url && (
                  <a
                    className="text-link"
                    href={r.url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open canonical review
                  </a>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
