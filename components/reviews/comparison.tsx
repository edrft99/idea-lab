"use client";
import Link from "@/components/navigation-link";
import type { EditableIdea, Idea } from "@/lib/ideas/domain";
import type { Proposal } from "@/lib/imports/model";
import {
  comparisonFields,
  comparisonLabels,
  textOverlap,
} from "@/lib/reviews/model";
import { useState } from "react";
function isCanonical(value: EditableIdea | Idea): value is Idea {
  return (
    "id" in value &&
    typeof value.id === "string" &&
    "sources" in value &&
    Array.isArray(value.sources)
  );
}
export function ComparisonCards({
  left,
  right,
  local = false,
}: {
  left: EditableIdea | Idea;
  right: EditableIdea | Idea;
  local?: boolean;
}) {
  const overlap = textOverlap(left, right);
  return (
    <>
      <div className="notice">
        <p>
          <strong>Word overlap: {Math.round(overlap.score * 100)}%</strong> · A
          local text hint, not semantic similarity or a duplicate verdict. No AI
          service is called.
          {overlap.shared.length > 0 && (
            <span className="shared-terms">
              {" "}
              Shared words: {overlap.shared.join(", ")}.
            </span>
          )}
        </p>
      </div>
      <div className="comparison-grid">
        {[left, right].map((idea, index) => (
          <article key={index} className="panel prose-panel comparison-card">
            <span className="tiny-label">
              {local
                ? index
                  ? "OTHER DRAFT"
                  : "SELECTED DRAFT"
                : index
                  ? "POSSIBLE MATCH"
                  : "CANDIDATE"}
            </span>
            <h2>{idea.title || "Untitled idea"}</h2>
            {isCanonical(idea) && (
              <>
                <Link className="text-link" href={"/ideas/" + idea.id}>
                  Open full canonical idea
                </Link>
                <p className="subtle-note">
                  {idea.status} · Potential {idea.priorityScore ?? "Unrated"}
                  {idea.priorityScore === null ? "" : "/100"} · {idea.effort}
                </p>
              </>
            )}
            {comparisonFields
              .filter((k) => k !== "title")
              .map((k) => (
                <div className="comparison-field" key={k}>
                  <h3>{comparisonLabels[k]}</h3>
                  <p className="preserve-text">{idea[k] || "Not recorded."}</p>
                </div>
              ))}
            {isCanonical(idea) && (
              <details>
                <summary>{idea.sources.length} source references</summary>
                {idea.sources.map((s) => (
                  <div className="comparison-source" key={s.id}>
                    <strong>{s.system}</strong>
                    <p>{s.summary || "No source summary."}</p>
                    {s.url && (
                      <a
                        className="text-link"
                        href={s.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        Open original source
                      </a>
                    )}
                  </div>
                ))}
              </details>
            )}
          </article>
        ))}
      </div>
    </>
  );
}
export function DraftComparison({
  current,
  proposals,
  onSkip,
}: {
  current: Proposal;
  proposals: Proposal[];
  onSkip: (id: string) => void;
}) {
  const [otherId, setOtherId] = useState(""),
    other = proposals.find((p) => p.id === otherId && p.id !== current.id);
  return (
    <section className="draft-comparison">
      <div className="panel prose-panel">
        <span className="tiny-label">COMPARE BEFORE CAPTURING</span>
        <h2>Could these be the same idea?</h2>
        <p>
          Compare local draft snapshots before saving. A local skip is retained
          in your review download; it does not merge records or record a
          canonical rejection.
        </p>
        <label>
          Compare with draft
          <select
            aria-label="Compare with draft"
            value={otherId}
            onChange={(e) => setOtherId(e.target.value)}
          >
            <option value="">Choose another draft</option>
            {proposals
              .filter((p) => p.id !== current.id)
              .map((p) => (
                <option value={p.id} key={p.id}>
                  {p.data.title || "Untitled draft"} · {p.decision}
                </option>
              ))}
          </select>
        </label>
      </div>
      {other && (
        <>
          <ComparisonCards left={current.data} right={other.data} local />
          {other.decision === "draft" && (
            <button
              className="site-secondary"
              type="button"
              onClick={() => onSkip(other.id)}
            >
              Skip the other draft locally
            </button>
          )}
        </>
      )}
    </section>
  );
}
