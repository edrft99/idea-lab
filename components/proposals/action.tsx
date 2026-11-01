"use client";
import Link from "@/components/navigation-link";
import { useState, useEffect, useRef } from "react";
import { requestData, ApiFailure } from "@/components/ideas/use-resource";
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
};
export function ReviewedAction({
  base,
  reviewPath = "/review/proposals/",
  input,
  label,
  approvalLabel,
  onDone,
  children,
}: {
  base: string;
  reviewPath?: string;
  input: unknown;
  label: string;
  approvalLabel: string;
  onDone: (id: string) => void;
  children: React.ReactNode;
}) {
  const [receipt, setReceipt] = useState<Receipt | null>(null),
    [command, setCommand] = useState<unknown>(null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState<ApiFailure | null>(null),
    [done, setDone] = useState(""),
    [ready, setReady] = useState(false);
  const running = useRef(false),
    fingerprint = JSON.stringify(input);
  useEffect(() => setReady(true), []);
  useEffect(() => {
    if (!uncertain) {
      setReceipt(null);
      setCommand(null);
      setError(null);
    }
  }, [fingerprint]);
  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      setReceipt(
        await requestData<Receipt>(base + "/prepare", {
          method: "POST",
          body: JSON.stringify(input),
        }),
      );
      setCommand(input);
    } catch (e) {
      setError(
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "UNAVAILABLE",
              "The proposal review could not be prepared.",
              503,
            ),
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function save(check = false) {
    if (running.current || !receipt) return;
    running.current = true;
    setBusy(true);
    setError(null);
    try {
      if (!check) setUncertain(true);
      const result = await requestData<{
        status?: string;
        reviewId?: string;
        canResume?: boolean;
      }>(base + (check ? "/status" : "/commit"), {
        method: "POST",
        body: JSON.stringify(
          check
            ? { approvalToken: receipt.approvalToken }
            : { command, approvalToken: receipt.approvalToken },
        ),
      });
      if (check && result.status !== "done") {
        setError(
          new ApiFailure(
            "RECONCILIATION_REQUIRED",
            result.canResume
              ? "The canonical capture is verified. Open Recent Saves to finish the original queue update."
              : "The save remains unconfirmed. No write was replayed; inspect Recent Saves before another attempt.",
            409,
            true,
          ),
        );
        return;
      }
      if (!result.reviewId) throw new Error("Missing result");
      setDone(result.reviewId);
      setUncertain(false);
      onDone(result.reviewId);
    } catch (e) {
      const failure =
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "WRITE_UNCERTAIN",
              "The response did not confirm this save. Check its status.",
              503,
              true,
            );
      setError(failure);
      if (
        !failure.uncertain &&
        failure.status < 500 &&
        failure.code !== "RECONCILIATION_REQUIRED"
      )
        setUncertain(false);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div>
      {done ? (
        <p role="status">
          Saved in Notion.{" "}
          <Link className="text-link" href={reviewPath + done}>
            Open proposal
          </Link>
        </p>
      ) : (
        <>
          <form method="post" onSubmit={prepare}>
            <fieldset
              className="import-ready"
              disabled={!ready || busy || !!receipt || uncertain}
            >
              {children}
              <button className="site-secondary" type="submit">
                {label}
              </button>
            </fieldset>
          </form>
          {receipt && (
            <section className="approval-panel mt-panel">
              <h3>Review this proposal action</h3>
              <dl className="change-list">
                {receipt.changes.map((c, n) => (
                  <div key={n}>
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
                {new Date(receipt.expiresAt).toLocaleTimeString()}.
              </p>
              <button
                className="site-primary"
                disabled={busy}
                onClick={() => save(uncertain)}
              >
                {uncertain ? "Check proposal save" : approvalLabel}
              </button>
              {!uncertain && (
                <button
                  className="site-secondary mt-button"
                  disabled={busy}
                  onClick={() => {
                    setReceipt(null);
                    setCommand(null);
                    setError(null);
                  }}
                >
                  Back to proposal editing
                </button>
              )}
              <Link className="text-link" href="/settings">
                Open Recent Saves
              </Link>
            </section>
          )}
        </>
      )}
      {error && (
        <div className="form-error" role="alert">
          <p>{error.message}</p>
          {error.reviewIds.map((id) => (
            <Link key={id} className="text-link" href={reviewPath + id}>
              Inspect saved proposal
            </Link>
          ))}
          {error.canonicalIdeaIds.map((id) => (
            <Link key={id} className="text-link" href={"/ideas/" + id}>
              Inspect canonical idea
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
