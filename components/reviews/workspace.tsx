"use client";
import Link from "@/components/navigation-link";
import { RelatedLink } from "@/components/links/workspace";
import { useState, useEffect, useRef } from "react";
import { RefreshCw, Check } from "lucide-react";
import { type Idea } from "@/lib/ideas/domain";
import {
  type PairContext,
  type DecisionCommand,
  decisionCommandSchema,
  decisions,
} from "@/lib/reviews/model";
import { ComparisonCards } from "./comparison";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
function readable(raw: string) {
  try {
    const value = JSON.parse(raw);
    return typeof value.decision === "string"
      ? value.decision +
          (typeof value.reason === "string" ? " · " + value.reason : "")
      : raw;
  } catch {
    return raw;
  }
}
export function PairChooser() {
  const list = useResource<Idea[]>("/api/ideas"),
    [left, setLeft] = useState(""),
    [right, setRight] = useState("");
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SIMILAR DOESN’T HAVE TO MEAN THE SAME</div>
          <h1>
            Make the connection<span>.</span>
          </h1>
          <p>Compare two canonical ideas and record your judgment.</p>
        </div>
      </div>
      <Link className="text-link" href="/review/merge">
        Review a merge with a named survivor
      </Link>
      <Link className="text-link" href="/sources">
        Compare unconnected import drafts in Sources & imports
      </Link>
      {list.error ? (
        <Failure error={list.error} retry={list.refresh} />
      ) : !list.data ? (
        <Loading />
      ) : list.data.length < 2 ? (
        <section className="panel empty-state">
          <h2>Choose a pair once you have two ideas.</h2>
          <p>Only saved, authorized Notion ideas are listed here.</p>
        </section>
      ) : (
        <>
          <section className="panel prose-panel">
            <div className="editor-select-grid">
              <label>
                Candidate idea
                <select
                  aria-label="Candidate idea"
                  value={left}
                  onChange={(e) => setLeft(e.target.value)}
                >
                  <option value="">Choose a candidate</option>
                  {list.data.map((i) => (
                    <option value={i.id} key={i.id}>
                      {i.title || "Untitled idea"}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Possible matching idea
                <select
                  aria-label="Possible matching idea"
                  value={right}
                  onChange={(e) => setRight(e.target.value)}
                >
                  <option value="">Choose a possible match</option>
                  {list.data
                    .filter((i) => i.id !== left)
                    .map((i) => (
                      <option value={i.id} key={i.id}>
                        {i.title || "Untitled idea"}
                      </option>
                    ))}
                </select>
              </label>
            </div>
          </section>
          {left && right && left !== right && (
            <PairResource
              key={left + right}
              url={
                "/api/reviews/comparison?candidateId=" +
                left +
                "&matchingId=" +
                right
              }
            />
          )}
        </>
      )}
    </div>
  );
}
export function ExistingReview({ id }: { id: string }) {
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR JUDGMENT, PRESERVED</div>
          <h1>
            Take a closer look<span>.</span>
          </h1>
          <p>Compare the evidence before resolving this review.</p>
        </div>
      </div>
      <Link className="text-link" href="/review">
        Back to the review center
      </Link>
      <PairResource url={"/api/reviews/" + id} />
    </div>
  );
}
function PairResource({ url }: { url: string }) {
  const resource = useResource<PairContext>(url);
  return resource.error ? (
    <Failure error={resource.error} retry={resource.refresh} />
  ) : !resource.data ? (
    <Loading />
  ) : (
    <>
      <button
        className="site-secondary mt-button"
        onClick={resource.refresh}
        disabled={resource.loading}
      >
        <RefreshCw size={15} />
        Refresh comparison
      </button>
      <DecisionPanel
        key={
          resource.data.candidate.revision +
          resource.data.matching.revision +
          (resource.data.review?.revision ?? "")
        }
        context={resource.data}
      />
    </>
  );
}
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
};
function DecisionPanel({ context }: { context: PairContext }) {
  const [choice, setChoice] = useState(""),
    [reason, setReason] = useState(""),
    [reconsider, setReconsider] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [command, setCommand] = useState<DecisionCommand | null>(null),
    [error, setError] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [saved, setSaved] = useState<string | null>(null);
  const inFlight = useRef(false),
    resolved = !!context.review && context.review.status !== "Pending";
  useEffect(() => setReady(true), []);
  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (inFlight.current) return;
    setError("");
    const parsed = decisionCommandSchema.safeParse({
      candidateId: context.candidate.id,
      matchingId: context.matching.id,
      candidateRevision: context.candidate.revision,
      matchingRevision: context.matching.revision,
      reviewId: context.review?.id ?? null,
      reviewRevision: context.review?.revision ?? null,
      decision: choice,
      reason,
      reconsider,
    });
    if (!parsed.success) {
      setError(
        "Choose a relationship decision and explain the evidence behind it.",
      );
      return;
    }
    if (
      context.priorDecision &&
      !reconsider &&
      !(context.review && choice === "Reject")
    ) {
      setError(
        "Choose to reconsider this content pair before recording a different classification.",
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    try {
      const result = await requestData<Receipt>("/api/reviews/prepare", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });
      setReceipt(result);
      setCommand(parsed.data);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The decision could not be reviewed.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!receipt || !command || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestData<{ decisionId: string }>(
        "/api/reviews/commit",
        {
          method: "POST",
          body: JSON.stringify({
            command,
            approvalToken: receipt.approvalToken,
          }),
        },
      );
      setSaved(result.decisionId);
      setReceipt(null);
    } catch (e) {
      const failure =
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "WRITE_UNCERTAIN",
              "The save outcome is unknown. Check it before submitting another decision.",
              503,
              true,
            );
      setError(failure.message);
      if (failure.uncertain || failure.code === "RECONCILIATION_REQUIRED")
        setUncertain(true);
      else if (failure.code !== "SAVE_BUSY") {
        setReceipt(null);
        setCommand(null);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!receipt || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestData<{
        status: string;
        decisionId: string | null;
      }>("/api/reviews/status", {
        method: "POST",
        body: JSON.stringify({ approvalToken: receipt.approvalToken }),
      });
      if (result.status === "done" && result.decisionId) {
        setSaved(result.decisionId);
        setReceipt(null);
        setUncertain(false);
      } else
        setError(
          "The save remains unconfirmed. Use Recent Saves before submitting another decision.",
        );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The save could not be checked.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="review-comparison">
      {context.review && (
        <section className="panel prose-panel">
          <span className="badge">{context.review.status}</span>
          <h2>{context.review.title || "Relationship review"}</h2>
          <p className="preserve-text">
            {context.review.reasoning || "No proposal reasoning recorded."}
          </p>
          <p>
            Recorded recommendation:{" "}
            {context.review.recommendation ?? "None; manual comparison"}
          </p>
          {context.review.decision && (
            <p>Reviewer decision: {readable(context.review.decision)}</p>
          )}
          {context.review.url && (
            <a
              className="text-link"
              href={context.review.url}
              target="_blank"
              rel="noreferrer"
            >
              Open canonical review
            </a>
          )}
        </section>
      )}
      {context.staleProposal && (
        <div className="notice">
          <p>
            This suggestion was based on older content or unknown input
            versions. You can reject the outdated suggestion here. Start a new
            comparison to classify the current ideas.
          </p>
        </div>
      )}
      {context.priorDecision && (
        <section className="panel prose-panel">
          <h2>This content pair has a prior decision</h2>
          <p className="preserve-text">
            {readable(context.priorDecision.decision) ||
              context.priorDecision.status}
          </p>
          <p>
            Score and status changes alone do not resurface this pair.
            Reconsidering is an explicit choice.
          </p>
        </section>
      )}
      {context.reopened && (
        <div className="notice">
          <p>
            One or both ideas contain different comparison content than their
            previous decision. Review this pair again using the current
            evidence.
          </p>
        </div>
      )}
      <ComparisonCards left={context.candidate} right={context.matching} />
      <RelatedLink
        key={context.candidate.revision + context.matching.revision}
        left={context.candidate}
        right={context.matching}
      />
      {saved ? (
        <section className="panel empty-state" role="status">
          <Check size={25} />
          <h2>Decision confirmed.</h2>
          <p>
            Your classification was recorded. Idea descriptions, scores, sources
            and histories were preserved.
          </p>
          <Link className="site-primary" href={"/review/" + saved}>
            Open saved decision
          </Link>
        </section>
      ) : resolved ? (
        <section className="panel prose-panel">
          <h2>This review is resolved.</h2>
          <p>
            Its history is preserved. Start a new comparison if the content has
            changed or you want to explicitly reconsider it.
          </p>
          <Link className="site-secondary" href="/review/compare">
            Start a comparison
          </Link>
        </section>
      ) : (
        <>
          <form method="post" onSubmit={review} className="panel prose-panel">
            <fieldset
              className="import-ready"
              disabled={!ready || busy || !!receipt || uncertain}
            >
              <h2>What is their relationship?</h2>
              <label>
                Relationship decision
                <select
                  aria-label="Relationship decision"
                  value={choice}
                  onChange={(e) => setChoice(e.target.value)}
                >
                  <option value="">Keep pending / choose a decision</option>
                  {decisions
                    .filter((v) => v !== "Reject" || !!context.review)
                    .map((v) => (
                      <option
                        key={v}
                        value={v}
                        disabled={context.staleProposal && v !== "Reject"}
                      >
                        {v === "Reject" ? "Reject this suggestion" : v}
                      </option>
                    ))}
                </select>
              </label>
              <label>
                Decision reason
                <textarea
                  rows={4}
                  maxLength={4000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              {context.priorDecision && (
                <label className="turn-select">
                  <input
                    type="checkbox"
                    checked={reconsider}
                    onChange={(e) => setReconsider(e.target.checked)}
                  />
                  Reconsider this content pair
                </label>
              )}
              <p className="subtle-note">
                This records a classification only. Use Link these ideas for a
                separately approved related link. Duplicate does not merge the
                ideas. Leaving the choice blank keeps the review pending without
                writing a decision.
              </p>
              <button className="site-primary" type="submit">
                {busy ? "Preparing…" : "Review relationship decision"}
              </button>
            </fieldset>
          </form>
          {receipt && (
            <section className="panel prose-panel approval-panel">
              <h2>Review before recording</h2>
              <dl className="change-list">
                {receipt.changes.map((c) => (
                  <div key={c.field}>
                    <dt>{c.field}</dt>
                    <dd>
                      {c.before && <del>{c.before}</del>}
                      <span>{c.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Approval expires at{" "}
                {new Date(receipt.expiresAt).toLocaleTimeString()}. Both idea
                versions and this review will be checked again before saving.
              </p>
              {uncertain ? (
                <button
                  className="site-primary"
                  disabled={busy}
                  onClick={check}
                >
                  Check decision save
                </button>
              ) : (
                <>
                  <button
                    className="site-primary"
                    disabled={busy}
                    onClick={save}
                  >
                    {busy ? "Saving…" : "Approve relationship decision"}
                  </button>
                  <button
                    className="site-secondary mt-button"
                    disabled={busy}
                    onClick={() => {
                      setReceipt(null);
                      setCommand(null);
                      setError("");
                    }}
                  >
                    Back to decision editing
                  </button>
                </>
              )}
              <Link className="text-link" href="/settings">
                Open Recent Saves
              </Link>
            </section>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {context.history.length > 0 && (
        <section className="panel prose-panel">
          <h2>Recorded review history</h2>
          {context.history.map((r) => (
            <div className="review-history-row" key={r.id}>
              <strong>
                {r.status} · {readable(r.decision) || r.title}
              </strong>
              <small>{r.reviewedAt ?? r.updatedAt}</small>
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
          ))}
        </section>
      )}
    </div>
  );
}
