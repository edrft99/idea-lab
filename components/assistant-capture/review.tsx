"use client";
import Link from "@/components/navigation-link";
import { useRef, useState } from "react";
import { useResource, requestData } from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
import { captureRetention } from "@/lib/assistant-capture/model";
type View = {
  proposalId: string;
  status: string;
  client?: string;
  expiresAt?: string;
  canApprove?: boolean;
  stale?: boolean;
  message: string;
  ideaId?: string;
  canonicalUrl?: string | null;
  changes?: { field: string; before: string; after: string }[];
  command?: { action: "create" | "update"; data: { title: string } };
};
export function AssistantCaptureReview({ id }: { id: string }) {
  const resource = useResource<View>("/api/assistant-capture/" + id),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(""),
    [sent, setSent] = useState(false),
    [result, setResult] = useState<View | null>(null),
    [error, setError] = useState(""),
    running = useRef(false),
    view = result ?? resource.data;
  async function act(action: "approve" | "reject" | "status") {
    if (running.current || (action === "approve" && (!checked || sent))) return;
    running.current = true;
    setBusy(action);
    setError("");
    if (action === "approve") setSent(true);
    try {
      const state = await requestData<View>(
        "/api/assistant-capture/" + action,
        { method: "POST", body: JSON.stringify({ proposalId: id }) },
      );
      if (action === "status" && state.status === "pending") {
        setResult(null);
        setSent(false);
        setChecked(false);
        resource.refresh();
      } else {
        setResult(state);
        if (state.status === "done" || state.status === "cancelled")
          resource.refresh();
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "This capture could not be confirmed. Check status before another save.",
      );
    } finally {
      running.current = false;
      setBusy("");
    }
  }
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">FROM YOUR ASSISTANT TO YOUR IDEA LAB</div>
          <h1>
            Review this capture<span>.</span>
          </h1>
          <p>
            {view?.client
              ? "Prepared from " + view.client
              : "Selected assistant draft"}
          </p>
        </div>
        <Link className="site-secondary" href="/ideas">
          Open idea explorer
        </Link>
      </div>
      {resource.error && !view ? (
        <Failure error={resource.error} retry={resource.refresh} />
      ) : !view ? (
        <Loading />
      ) : (
        <>
          <section className="panel prose-panel mt-panel">
            <div className="section-heading">
              <h2>
                {view.status === "done"
                  ? "Saved in Notion"
                  : view.status === "cancelled"
                    ? "Capture rejected"
                    : (view.command?.data.title ?? "Capture status")}
              </h2>
              <span className="badge">{view.status}</span>
            </div>
            <p>{view.message}</p>
            {view.expiresAt && view.status === "pending" && (
              <p className="subtle-note">
                Review expires {new Date(view.expiresAt).toLocaleTimeString()}.
                Nothing is canonical until this save is confirmed.
              </p>
            )}
            {view.status === "done" && (
              <div className="action-row">
                {view.ideaId && (
                  <Link className="site-primary" href={"/ideas/" + view.ideaId}>
                    Open saved idea
                  </Link>
                )}
                {view.canonicalUrl && (
                  <a
                    className="site-secondary"
                    href={view.canonicalUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open canonical Notion record
                  </a>
                )}
              </div>
            )}
            {view.changes && view.status === "pending" && (
              <>
                <p className="notice">
                  Approve only the exact idea fields and reported source
                  evidence below. Saving{" "}
                  {view.command?.action === "update"
                    ? "updates this canonical idea while preserving sources, scores and evaluation history"
                    : "creates a canonical idea and linked source"}
                  . It does not call a model or approve a merge.
                </p>
                {view.changes.map((change, i) => (
                  <div className="diff-row" key={i}>
                    <h3>{change.field}</h3>
                    {change.before && (
                      <>
                        <strong>Current value</strong>
                        <p className="preserve-text">{change.before}</p>
                      </>
                    )}
                    <strong>Proposed value</strong>
                    <p className="preserve-text">{change.after || "Empty"}</p>
                  </div>
                ))}
                <label className="semantic-choice">
                  <input
                    type="checkbox"
                    aria-label="I reviewed the idea fields and selected source evidence"
                    checked={checked}
                    disabled={!!busy || sent || !view.canApprove}
                    onChange={(e) => setChecked(e.target.checked)}
                  />
                  <span>
                    I reviewed the idea fields and selected source evidence.
                  </span>
                </label>
                <div className="action-row">
                  <button
                    className="site-primary"
                    disabled={!!busy || sent || !checked || !view.canApprove}
                    onClick={() => act("approve")}
                  >
                    {busy === "approve"
                      ? "Saving the approved capture…"
                      : "Approve and save in Notion"}
                  </button>
                  <button
                    className="site-secondary"
                    disabled={!!busy || sent}
                    onClick={() => act("reject")}
                  >
                    Reject this capture
                  </button>
                </div>
              </>
            )}
            {(sent ||
              ["running", "uncertain", "failed"].includes(view.status)) &&
              view.status !== "done" && (
                <button
                  className="site-secondary"
                  disabled={!!busy}
                  onClick={() => act("status")}
                >
                  {busy === "status" ? "Checking…" : "Check save status"}
                </button>
              )}
            {view.status === "expired" && (
              <p>
                Ask your assistant to prepare a fresh request after checking the
                prior operation. Expired drafts cannot be approved or saved.
              </p>
            )}
          </section>
          <p className="subtle-note mt-panel">
            {captureRetention} Client permissions and model text cannot grant
            this website approval.
          </p>
        </>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {busy && (
        <p role="status">
          {busy === "approve"
            ? "Saving exactly the reviewed fields…"
            : busy === "reject"
              ? "Rejecting the temporary draft…"
              : "Checking the prior save without replaying it…"}
        </p>
      )}
    </div>
  );
}
