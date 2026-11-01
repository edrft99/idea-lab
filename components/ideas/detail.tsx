"use client";
import Link from "@/components/navigation-link";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  RefreshCw,
  Pencil,
  Target,
} from "lucide-react";
import type { IdeaDetail } from "@/lib/ideas/domain";
import { useResource } from "./use-resource";
import { Failure, Loading } from "./states";
import { Attachments } from "./attachments";
export function Detail({ id }: { id: string }) {
  const { data, error, loading, refresh, stale } = useResource<IdeaDetail>(
      "/api/ideas/" + id,
    ),
    idea = data?.idea;
  return (
    <div className="page detail-page">
      <Link className="back-link" href="/ideas">
        <ArrowLeft size={15} />
        Back to your ideas
      </Link>
      {error ? (
        <Failure error={error} retry={refresh} stale={stale} />
      ) : !data || !idea ? (
        <Loading />
      ) : (
        <>
          <div className="detail-heading">
            <div>
              <div className="eyebrow">{idea.category}</div>
              <h1>
                {idea.title || "Untitled record"}
                <span>.</span>
              </h1>
              <p>{idea.summary || "No summary saved yet."}</p>
              <div className="detail-tags">
                <span className={"badge " + idea.status.toLowerCase()}>
                  {idea.status}
                </span>
                <span>
                  {(data.sources ?? idea.sources).length} linked sources
                </span>
                <span>{idea.createdAt.slice(0, 10)}</span>
              </div>
            </div>
            <div className="large-score">
              <span>POTENTIAL SCORE</span>
              <strong>
                {idea.priorityScore ?? "—"}
                <small>/100</small>
              </strong>
              <span>
                {idea.scoreAuthority === "manual-approved"
                  ? "Manually approved"
                  : (idea.scoreAuthority ?? "Not evaluated")}
              </span>
            </div>
          </div>
          {idea.canonicalIdeaId && (
            <div className="notice" role="status">
              <p>
                This original is preserved after a merge. Continue work on the
                surviving idea.
              </p>
              <Link
                className="text-link"
                href={"/ideas/" + idea.canonicalIdeaId}
              >
                Open surviving idea
              </Link>
            </div>
          )}
          <div className="action-row detail-actions">
            {!idea.canonicalIdeaId && (
              <>
                <Link href={"/ideas/" + id + "/edit"} className="site-primary">
                  <Pencil size={14} />
                  Edit idea & status
                </Link>
                <Link
                  className="site-secondary"
                  href={"/ideas/" + id + "/evaluate"}
                >
                  Evaluate idea
                </Link>
              </>
            )}
            <button
              className="site-secondary"
              onClick={refresh}
              disabled={loading}
            >
              <RefreshCw size={14} />
              Refresh
            </button>
            {idea.url && (
              <a
                className="site-secondary"
                href={idea.url}
                target="_blank"
                rel="noreferrer"
              >
                Open canonical record <ArrowUpRight size={14} />
              </a>
            )}
          </div>
          <div className="detail-columns">
            <div>
              <section className="panel prose-panel">
                <h2>The idea</h2>
                {[
                  { label: "Problem statement", value: idea.problem },
                  { label: "Proposed solution", value: idea.solution },
                  { label: "Intended audience", value: idea.audience },
                  { label: "Expected value", value: idea.expectedValue },
                  { label: "Relevant context", value: idea.context },
                ].map((v) => (
                  <div key={v.label}>
                    <h3>{v.label}</h3>
                    <p className="preserve-text">
                      {v.value || "Not recorded."}
                    </p>
                  </div>
                ))}
              </section>
              <Attachments
                key={idea.id}
                ideaId={idea.id}
                readOnly={!!idea.canonicalIdeaId}
                onSaved={refresh}
              />
              <section className="panel prose-panel">
                <h2>Current score breakdown</h2>
                <dl>
                  {Object.entries(idea.scores).map(([k, v]) => (
                    <div key={k}>
                      <dt className="capitalize">
                        {k === "alignment" ? "Strategic alignment" : k}
                      </dt>
                      <dd>{v === null ? "Unrated" : v + "/5"}</dd>
                    </div>
                  ))}
                </dl>
                <p className="subtle-note">
                  Editing this idea does not change evaluation scores or
                  manually approved assessments.
                </p>
              </section>
              <section className="panel prose-panel">
                <h2>Where this idea came from</h2>
                {(data.sources ?? idea.sources).length ? (
                  (data.sources ?? idea.sources).map((s) => (
                    <div className="source-row" key={s.id}>
                      <span className="source-letter">
                        {s.system.slice(0, 1)}
                      </span>
                      <div>
                        <strong>{s.system}</strong>
                        <p className="preserve-text">
                          {s.summary || "No extracted summary recorded."}
                        </p>
                        <small>
                          {s.identifier}
                          {s.conversationDate
                            ? " · " + s.conversationDate.slice(0, 10)
                            : ""}
                        </small>
                        <div className="source-origin-links">
                          {s.ideaIds
                            .filter((original) => original !== idea.id)
                            .map((original) => (
                              <Link
                                key={original}
                                className="text-link"
                                href={"/ideas/" + original}
                              >
                                Source recorded on{" "}
                                {data.mergedIdeas?.find(
                                  (i) => i.id === original,
                                )?.title ?? "original idea"}
                              </Link>
                            ))}
                          {s.url && (
                            <a
                              className="text-link"
                              href={s.url}
                              target="_blank"
                              rel="noreferrer"
                            >
                              Open original source <ArrowUpRight size={13} />
                            </a>
                          )}
                        </div>
                      </div>
                    </div>
                  ))
                ) : (
                  <p>No source records are linked.</p>
                )}
              </section>
              {!!data.mergedIdeas?.length && (
                <section className="panel prose-panel">
                  <h2>Preserved originals</h2>
                  <p>
                    These records point into this canonical lineage. Their
                    descriptions, sources and assessments remain on the original
                    records.
                  </p>
                  {data.mergedIdeas.map((original) => (
                    <details className="evaluation-entry" key={original.id}>
                      <summary>
                        <strong>{original.title || "Untitled original"}</strong>
                        <small>
                          {original.status} · Original score{" "}
                          {original.priorityScore ?? "Unrated"}
                        </small>
                      </summary>
                      <Link
                        className="text-link"
                        href={"/ideas/" + original.id}
                      >
                        Open preserved original
                      </Link>
                      <p className="preserve-text">
                        {original.summary || "No summary recorded."}
                      </p>
                      {[
                        ["Problem", original.problem],
                        ["Solution", original.solution],
                        ["Audience", original.audience],
                        ["Expected value", original.expectedValue],
                        ["Context", original.context],
                      ].map(([label, value]) => (
                        <div key={label}>
                          <h3>{label}</h3>
                          <p className="preserve-text">
                            {value || "Not recorded."}
                          </p>
                        </div>
                      ))}
                    </details>
                  ))}
                </section>
              )}
              <section className="panel prose-panel">
                <h2>Evaluation history</h2>
                {!data.evaluations.length ? (
                  <p>No evaluations saved yet.</p>
                ) : (
                  data.evaluations.map((e) => (
                    <details
                      className="evaluation-entry"
                      key={e.id}
                      open={e.id === idea.latestEvaluationId}
                    >
                      <summary>
                        <strong>
                          {e.authority === "manual-approved"
                            ? "Approved manual assessment"
                            : "Evaluation proposal"}
                        </strong>
                        <span>{e.overallScore ?? "Unrated"}</span>
                        <small>
                          {e.date?.slice(0, 10) ?? "Date not recorded"} ·{" "}
                          {e.rubricVersion}
                        </small>
                      </summary>
                      {e.originalIdeaIds
                        ?.filter((original) => original !== idea.id)
                        .map((original) => (
                          <Link
                            className="text-link"
                            key={original}
                            href={"/ideas/" + original}
                          >
                            Assessment of{" "}
                            {data.mergedIdeas?.find((i) => i.id === original)
                              ?.title ?? "preserved original"}
                          </Link>
                        ))}
                      <h3>Rationale</h3>
                      <p className="preserve-text">
                        {e.rationale || "Not recorded."}
                      </p>
                      <dl>
                        {Object.entries(e.scores).map(([k, v]) => (
                          <div key={k}>
                            <dt className="capitalize">{k}</dt>
                            <dd>{v ?? "Unrated"}</dd>
                          </div>
                        ))}
                      </dl>
                      {[
                        { label: "Benefits", v: e.benefits },
                        { label: "Risks", v: e.risks },
                        { label: "Assumptions", v: e.assumptions },
                        { label: "Next action", v: e.nextAction },
                      ].map((v) => (
                        <div key={v.label}>
                          <h3>{v.label}</h3>
                          <p className="preserve-text">
                            {v.v || "Not recorded."}
                          </p>
                        </div>
                      ))}
                      <p className="subtle-note">
                        Model: {e.model || "Not recorded"} · Effort:{" "}
                        {e.effort ?? "Unknown"} · Readiness:{" "}
                        {e.readiness ?? "Unknown"} · Confidence:{" "}
                        {e.confidence === null
                          ? "Unknown"
                          : Math.round(e.confidence * 100) + "%"}
                      </p>
                    </details>
                  ))
                )}
              </section>
            </div>
            <aside className="detail-aside">
              <section className="next-action">
                <div className="eyebrow">
                  <Target size={15} />
                  THE NEXT SMALL STEP
                </div>
                <h2>Give this idea a little momentum.</h2>
                <p className="preserve-text">
                  {idea.nextAction || "No next action recorded yet."}
                </p>
              </section>
              <section className="panel prose-panel">
                <h2>At a glance</h2>
                <dl>
                  <div>
                    <dt>Estimated effort</dt>
                    <dd>{idea.effort}</dd>
                  </div>
                  <div>
                    <dt>Readiness</dt>
                    <dd>{idea.readiness}</dd>
                  </div>
                  <div>
                    <dt>Confidence</dt>
                    <dd>
                      {idea.confidence === null
                        ? "Unrated"
                        : Math.round(idea.confidence * 100) + "%"}
                    </dd>
                  </div>
                  <div>
                    <dt>Status</dt>
                    <dd>{idea.status}</dd>
                  </div>
                </dl>
                {idea.projectUrl ? (
                  <a
                    className="text-link"
                    href={idea.projectUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open project <ArrowUpRight size={14} />
                  </a>
                ) : (
                  <p>No project linked yet.</p>
                )}
              </section>
              <section className="panel prose-panel">
                <h2>Connected ideas</h2>
                {data.relatedIdeas.length ? (
                  data.relatedIdeas.map((i) => (
                    <Link
                      className="related-link"
                      key={i.id}
                      href={"/ideas/" + i.id}
                    >
                      {i.title || "Untitled record"}
                      <ArrowRight size={14} />
                    </Link>
                  ))
                ) : (
                  <p>No readable related ideas were found.</p>
                )}
                {data.relatedTotal > 20 && (
                  <p className="subtle-note">
                    Showing up to 20 related records. Open the canonical record
                    for the complete relation.
                  </p>
                )}
              </section>
              <section className="panel prose-panel">
                <h2>Pending review</h2>
                {data.reviews.length ? (
                  data.reviews.map((r) => (
                    <p key={r.id}>
                      {r.type}: {r.recommendation ?? "Uncertain"}
                    </p>
                  ))
                ) : (
                  <p>No pending review references this idea.</p>
                )}
                <Link className="text-link" href="/review">
                  Open review center <ArrowRight size={14} />
                </Link>
              </section>
            </aside>
          </div>
        </>
      )}
    </div>
  );
}
