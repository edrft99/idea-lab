"use client";
import Link from "@/components/navigation-link";
import { useState } from "react";
import { useResource, requestData, ApiFailure } from "./use-resource";
const semanticLabels: Record<string, string> = {
  "semantic-index": "Selected index",
  "semantic-query": "Semantic query",
  "semantic-clear": "Derived cache clearing",
  "semantic-snapshot-plan": "Snapshot plan",
  "semantic-snapshot-batch": "Snapshot batch",
  "semantic-snapshot-activate": "Snapshot activation",
  "semantic-snapshot-discard": "Inactive snapshot discard",
};
const isProposal = (action: string) =>
  action.startsWith("proposal-") || action.startsWith("assessment-");
const isReviewResult = (action: string) =>
  /^(proposal|assessment)-(store|reject)$/.test(action);
const reviewPath = (action: string) =>
  action.startsWith("assessment-")
    ? "/review/assessments/"
    : "/review/proposals/";
type Operation = {
  id: string;
  action: string;
  target: string | null;
  job_id?: string | null;
  status: string;
  result_id: string | null;
  created_at: number;
};
export function RecentSaves() {
  const { data, error, loading, refresh } =
      useResource<Operation[]>("/api/operations"),
    [busy, setBusy] = useState(""),
    [message, setMessage] = useState(""),
    [resumable, setResumable] = useState<string[]>([]);
  async function check(id: string) {
    setBusy(id);
    setMessage("");
    try {
      const result = await requestData<{
        status: string;
        ideaId: string | null;
        canResume?: boolean;
        message?: string;
        resultRetained?: boolean;
      }>("/api/operations/reconcile", {
        method: "POST",
        body: JSON.stringify({ operationId: id }),
      });
      setResumable((ids) =>
        result.canResume
          ? [...new Set([...ids, id])]
          : ids.filter((v) => v !== id),
      );
      setMessage(
        result.resultRetained === false && result.message
          ? result.message
          : result.status === "done"
            ? "Save confirmed."
            : "The save is still unconfirmed. No write was replayed.",
      );
      refresh();
    } catch (e) {
      setMessage(
        e instanceof ApiFailure ? e.message : "This save could not be checked.",
      );
    } finally {
      setBusy("");
    }
  }
  async function cancelDerived(id: string) {
    if (busy) return;
    setBusy(id);
    setMessage("");
    try {
      const result = await requestData<{ status: string; message: string }>(
        "/api/semantic/cancel",
        { method: "POST", body: JSON.stringify({ operationId: id }) },
      );
      setMessage(result.message);
      refresh();
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "The derived operation could not be cancelled.",
      );
    } finally {
      setBusy("");
    }
  }
  async function resume(id: string, action: string) {
    if (busy) return;
    setBusy(id);
    setMessage("");
    try {
      await requestData(
        action.startsWith("assessment-")
          ? "/api/assessment-proposals/resume"
          : isProposal(action)
            ? "/api/proposals/resume"
            : action === "merge-ideas"
              ? "/api/merges/resume"
              : "/api/links/resume",
        {
          method: "POST",
          body: JSON.stringify({ operationId: id }),
        },
      );
      setResumable((ids) => ids.filter((v) => v !== id));
      setMessage(
        isProposal(action)
          ? "Proposal decision confirmed."
          : action === "merge-ideas"
            ? "Merge confirmed. Originals and history are preserved."
            : "Related links confirmed in both directions.",
      );
      refresh();
    } catch (e) {
      setResumable((ids) => ids.filter((v) => v !== id));
      setMessage(
        e instanceof Error
          ? e.message
          : "The link recovery could not be confirmed. Check status.",
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="panel prose-panel mt-panel">
      <div className="section-heading">
        <h2>Recent saves</h2>
        <button className="site-secondary" onClick={refresh} disabled={loading}>
          Refresh
        </button>
      </div>
      <p className="subtle-note">
        Check a previous save after a connection problem or page reload.
        Checking status never submits the changes again.
      </p>
      {error ? (
        <p>{error.message}</p>
      ) : !data ? (
        <p role="status">Loading save history…</p>
      ) : !data.length ? (
        <p>No save approvals have been requested yet.</p>
      ) : (
        data.map((op) => (
          <div className="operation-row" key={op.id}>
            <div>
              <strong>
                {op.action === "attach-file"
                  ? "File attachment"
                  : op.action.startsWith("import-")
                    ? op.action === "import-create"
                      ? "Import capture"
                      : "Import recovery"
                    : op.action.startsWith("semantic-")
                      ? (semanticLabels[op.action] ?? "Semantic operation")
                      : ["ai-evaluate", "ai-extract"].includes(op.action)
                        ? op.action === "ai-extract"
                          ? "AI extraction request"
                          : "AI assessment request"
                        : isProposal(op.action)
                          ? op.action.endsWith("-store")
                            ? "Proposal storage"
                            : "Proposal decision"
                          : op.action === "merge-ideas"
                            ? "Idea merge"
                            : op.action === "related-link"
                              ? "Related link"
                              : op.action === "review-decision"
                                ? "Review decision"
                                : op.action.startsWith("evaluation-")
                                  ? "Evaluation"
                                  : op.action === "create"
                                    ? "Capture"
                                    : "Update"}{" "}
                · {op.status}
              </strong>
              <small>{new Date(op.created_at).toLocaleString()}</small>
            </div>
            {!op.action.startsWith("import-") &&
              (op.status === "uncertain" ||
                op.status === "running" ||
                (op.action === "semantic-index" && op.status === "failed")) && (
                <button
                  className="site-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => check(op.id)}
                >
                  {busy === op.id ? "Checking…" : "Check status"}
                </button>
              )}
            {op.job_id && (
              <Link className="text-link" href={"/sources?job=" + op.job_id}>
                Open import progress
              </Link>
            )}
            {op.action.startsWith("semantic-") &&
              ["pending", "running", "uncertain"].includes(op.status) && (
                <button
                  className="site-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => cancelDerived(op.id)}
                >
                  Cancel derived operation
                </button>
              )}
            {(["related-link", "merge-ideas"].includes(op.action) ||
              isProposal(op.action)) &&
              resumable.includes(op.id) &&
              op.status === "uncertain" && (
                <button
                  className="site-secondary"
                  disabled={Boolean(busy)}
                  onClick={() => resume(op.id, op.action)}
                >
                  {isProposal(op.action)
                    ? "Finish approved proposal decision"
                    : op.action === "merge-ideas"
                      ? "Resume approved merge"
                      : "Resume approved related links"}
                </button>
              )}
            {op.action === "attach-file" && op.target && (
              <Link className="text-link" href={"/ideas/" + op.target}>
                Open idea attachments
              </Link>
            )}
            {op.result_id &&
              op.action !== "attach-file" &&
              !op.action.startsWith("semantic-") &&
              !["ai-evaluate", "ai-extract"].includes(op.action) && (
                <Link
                  className="text-link"
                  href={
                    isReviewResult(op.action)
                      ? reviewPath(op.action) + op.result_id
                      : op.action === "review-decision"
                        ? "/review/" + op.result_id
                        : "/ideas/" +
                          (op.action.startsWith("evaluation-")
                            ? op.target
                            : op.result_id)
                  }
                >
                  {isReviewResult(op.action)
                    ? "Open saved proposal"
                    : op.action === "review-decision"
                      ? "Open saved decision"
                      : "Open saved idea"}
                </Link>
              )}
          </div>
        ))
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
