"use client";
import Link from "@/components/navigation-link";
import { useEffect, useState, useRef } from "react";
import type { Idea } from "@/lib/ideas/domain";
import { type LinkCommand, linkCommandSchema } from "@/lib/links/model";
import { requestData, ApiFailure } from "@/components/ideas/use-resource";
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
};
export function RelatedLink({ left, right }: { left: Idea; right: Idea }) {
  const [reason, setReason] = useState(""),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [command, setCommand] = useState<LinkCommand | null>(null),
    [busy, setBusy] = useState(false),
    [ready, setReady] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [message, setMessage] = useState(""),
    [done, setDone] = useState(false);
  const inFlight = useRef(false);
  useEffect(() => setReady(true), []);
  const linked =
    left.relatedIdeaIds.includes(right.id) &&
    right.relatedIdeaIds.includes(left.id);
  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    if (inFlight.current) return;
    const parsed = linkCommandSchema.safeParse({
      candidateId: left.id,
      matchingId: right.id,
      candidateRevision: left.revision,
      matchingRevision: right.revision,
      reason,
    });
    if (!parsed.success) {
      setMessage("Enter a reason for linking these ideas.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      setReceipt(
        await requestData<Receipt>("/api/links/prepare", {
          method: "POST",
          body: JSON.stringify(parsed.data),
        }),
      );
      setCommand(parsed.data);
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "The link could not be prepared.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function act(check = false) {
    if (inFlight.current || !receipt || !command) return;
    inFlight.current = true;
    setBusy(true);
    setMessage("");
    try {
      if (check) {
        const result = await requestData<{
          status: string;
          canResume?: boolean;
        }>("/api/links/status", {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        });
        if (result.status === "done") {
          setDone(true);
          setUncertain(false);
        } else
          setMessage(
            result.canResume
              ? "The link is partially saved. Open Recent Saves to explicitly resume the approved changes."
              : "The save remains unconfirmed. No write was replayed; inspect Recent Saves.",
          );
      } else {
        // Any lost response may conceal an accepted commit; never offer blind retry.
        setUncertain(true);
        await requestData("/api/links/commit", {
          method: "POST",
          body: JSON.stringify({
            command,
            approvalToken: receipt.approvalToken,
          }),
        });
        setDone(true);
        setUncertain(false);
      }
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "The link save could not be confirmed.",
      );
      if (
        e instanceof ApiFailure &&
        !e.uncertain &&
        e.status < 500 &&
        e.code !== "RECONCILIATION_REQUIRED"
      )
        setUncertain(false);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  if (left.canonicalIdeaId || right.canonicalIdeaId) return null;
  return (
    <section className="panel prose-panel">
      <h2>Link these ideas</h2>
      {done ? (
        <div role="status">
          <p>Related links confirmed in both directions.</p>
          <Link className="text-link" href={"/ideas/" + left.id}>
            Open linked idea
          </Link>
        </div>
      ) : linked ? (
        <p>These ideas are already linked in both directions.</p>
      ) : (
        <>
          <p>
            Add each idea to the other's related list. This action needs its own
            approval.
          </p>
          {!receipt ? (
            <form method="post" onSubmit={prepare}>
              <fieldset className="import-ready" disabled={!ready || busy}>
                <label>
                  Link reason
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </label>
                <button className="site-secondary" type="submit">
                  Review related links
                </button>
              </fieldset>
            </form>
          ) : (
            <div className="approval-panel">
              <h3>Review both related links</h3>
              <dl className="change-list">
                {receipt.changes.map((c) => (
                  <div key={c.field}>
                    <dt>{c.field}</dt>
                    <dd>
                      <del>{c.before}</del>
                      <span>{c.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Approval expires at{" "}
                {new Date(receipt.expiresAt).toLocaleTimeString()}. Both record
                versions will be checked again.
              </p>
              <button
                className="site-primary"
                disabled={busy}
                onClick={() => act(uncertain)}
              >
                {busy
                  ? "Checking…"
                  : uncertain
                    ? "Check related link save"
                    : "Approve related links"}
              </button>
              {!uncertain && (
                <button
                  className="site-secondary mt-button"
                  disabled={busy}
                  onClick={() => {
                    setReceipt(null);
                    setCommand(null);
                    setMessage("");
                  }}
                >
                  Back to link editing
                </button>
              )}
              <Link className="text-link" href="/settings">
                Open Recent Saves
              </Link>
            </div>
          )}
        </>
      )}
      {message && (
        <p role="status" className="form-error">
          {message}
        </p>
      )}
    </section>
  );
}
