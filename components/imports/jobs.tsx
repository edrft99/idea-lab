"use client";
import { useEffect, useRef, useState } from "react";
import Link from "@/components/navigation-link";
import { requestData } from "@/components/ideas/use-resource";
import { sourceKey, sourceRevision, type Proposal } from "@/lib/imports/model";
import type { ImportJobView } from "@/lib/imports/job-model";
import { matchesJobResult } from "@/lib/imports/job-proof";
import type { IdeaCommand } from "@/lib/ideas/domain";
type Review = {
  action?: string;
  approvalToken: string;
  expiresAt: string;
  changes: Array<{ field: string; before: string; after: string }>;
};
export function ImportJobs({
  proposals,
  jobId,
  refresh,
  onJob,
  onChoose,
  onSaved,
}: {
  proposals: Proposal[];
  jobId: string | null;
  refresh: number;
  onJob: (job: ImportJobView | null) => void;
  onChoose: (id: string) => void;
  onSaved: (itemId: string, ideaId: string, snapshot: string) => void;
}) {
  const [jobs, setJobs] = useState<ImportJobView[]>([]),
    [job, setJob] = useState<ImportJobView | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [preview, setPreview] = useState(false),
    [consent, setConsent] = useState(false),
    [recovery, setRecovery] = useState<{
      itemId: string;
      command: IdeaCommand;
      review: Review;
    } | null>(null);
  const inFlight = useRef(false),
    requestKey = useRef<string | null>(null),
    generation = useRef(0);
  const complete =
    !!job?.items.length && job.items.every((item) => item.status === "done");
  const candidates = proposals.filter((p) => p.decision === "draft" && !p.ai);
  const endpoint = (id: string, action: string) =>
    "/api/imports/jobs/" + id + "/" + action;
  function accept(value: ImportJobView) {
    setJob(value);
    onJob(value);
    setJobs((old) => [value, ...old.filter((j) => j.id !== value.id)]);
    for (const item of value.items) {
      const proposal = proposals.find((p) => p.id === item.id);
      if (proposal && item.ideaId) {
        const snapshot = JSON.stringify([proposal.data, proposal.source]);
        void matchesJobResult(item, proposal)
          .then((matches) => {
            if (matches) onSaved(item.id, item.ideaId!, snapshot);
          })
          .catch(() => {});
      }
    }
  }
  useEffect(() => {
    const n = ++generation.current;
    setRecovery(null);
    setError("");
    (async () => {
      try {
        const all = await requestData<ImportJobView[]>("/api/imports/jobs");
        if (n !== generation.current) return;
        setJobs(all);
        if (jobId) {
          const current = await requestData<ImportJobView>(
            endpoint(jobId, "status"),
          );
          if (n === generation.current) accept(current);
        } else setJob(null);
      } catch (e) {
        if (n === generation.current)
          setError(
            e instanceof Error ? e.message : "Import jobs could not be loaded.",
          );
      }
    })();
    return () => {
      generation.current++;
    };
  }, [jobId, refresh]);
  useEffect(() => {
    setPreview(false);
    setConsent(false);
    requestKey.current = null;
    setRecovery(null);
  }, [proposals]);
  async function action(work: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await work();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "This import action could not be confirmed. Check its status before another save.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function create() {
    if (!consent) return;
    await action(async () => {
      const key = requestKey.current ?? crypto.randomUUID();
      requestKey.current = key;
      const items = await Promise.all(
        candidates.map(async (p) => ({
          id: p.id,
          sourceKey: await sourceKey(p.source),
          sourceRevision: await sourceRevision(p.source),
        })),
      );
      const value = await requestData<ImportJobView>("/api/imports/jobs", {
        method: "POST",
        body: JSON.stringify({ requestKey: key, items }),
      });
      accept(value);
      setPreview(false);
      setConsent(false);
    });
  }
  async function control(which: "pause" | "cancel" | "resume") {
    if (!job) return;
    await action(async () => {
      accept(
        await requestData<ImportJobView>(endpoint(job.id, which), {
          method: "POST",
          body: "{}",
        }),
      );
      setRecovery(null);
    });
  }
  async function check(itemId: string) {
    if (!job) return;
    await action(async () =>
      accept(
        await requestData<ImportJobView>(endpoint(job.id, "check"), {
          method: "POST",
          body: JSON.stringify({ itemId }),
        }),
      ),
    );
  }
  async function reviewMissing(itemId: string) {
    if (!job) return;
    await action(async () => {
      const proposal = proposals.find((p) => p.id === itemId && !p.ai);
      if (!proposal)
        throw Error(
          "Restore the matching private review file before finishing this source.",
        );
      const command: IdeaCommand = {
        action: "create",
        data: proposal.data,
        source: proposal.source,
      };
      const review = await requestData<Review>(
        endpoint(job.id, "recover-review"),
        { method: "POST", body: JSON.stringify({ itemId, command }) },
      );
      setRecovery({ itemId, command, review });
    });
  }
  async function finishMissing() {
    if (!job || !recovery) return;
    const reviewed = recovery;
    setRecovery(null);
    await action(async () => {
      const result = await requestData<{ idea: { id: string } }>(
        endpoint(job.id, "recover"),
        {
          method: "POST",
          body: JSON.stringify({
            itemId: reviewed.itemId,
            command: reviewed.command,
            approvalToken: reviewed.review.approvalToken,
          }),
        },
      );
      accept(await requestData<ImportJobView>(endpoint(job.id, "status")));
    });
  }
  return (
    <section
      className="panel prose-panel import-jobs"
      aria-label="Recoverable import jobs"
    >
      <span className="tiny-label">PICK UP WHERE YOU LEFT OFF</span>
      <h2>Import progress</h2>
      <p>
        Track a selected batch across reloads. Draft text stays in your private
        review file. Each idea still needs its own review and save approval.
      </p>
      <p className="subtle-note">
        Jobs accept new saves for 30 days. The Site stores only checksums,
        record references and progress. Expired metadata is cleared during later
        job-list or tracking activity. Unresolved saves keep their recovery
        metadata until inspected. No model request or Notion save happens when
        you start tracking. Download progress before leaving; reopening that
        private file restores the draft text.
      </p>
      <div className="import-toolbar">
        <button
          className="site-secondary"
          disabled={busy || !candidates.length}
          onClick={() => {
            setPreview(true);
            setConsent(false);
          }}
        >
          Review tracking for {candidates.length} drafts
        </button>
        {job && (
          <button
            className="text-link"
            disabled={busy}
            onClick={() => {
              setJob(null);
              onJob(null);
            }}
          >
            Detach this job from the page
          </button>
        )}
      </div>
      {preview && (
        <div className="notice import-job-review">
          <h3>Track these selected drafts</h3>
          <ul>
            {candidates.map((p) => (
              <li key={p.id}>{p.data.title}</li>
            ))}
          </ul>
          <p>
            Only their identifiers and checksums will be retained by Idea Lab.
            Their selected text remains in this browser and your downloaded
            review file until you separately request an idea review.
            AI-extracted drafts continue through their separate saved-proposal
            workflow.
          </p>
          <label className="check-label">
            <input
              type="checkbox"
              checked={consent}
              onChange={(e) => setConsent(e.target.checked)}
            />
            Track only this selected batch under the displayed retention policy.
          </label>
          <button
            className="site-primary"
            disabled={busy || !consent || !candidates.length}
            onClick={() => void create()}
          >
            Start tracking this batch
          </button>
          <button
            className="site-secondary"
            disabled={busy}
            onClick={() => setPreview(false)}
          >
            Back
          </button>
        </div>
      )}
      {!job && jobs.length > 0 && (
        <div className="import-job-list">
          <h3>Recent jobs</h3>
          {jobs.map((j) => (
            <div key={j.id} className="import-proposal">
              <span>
                {new Date(j.createdAt).toLocaleString()} ·{" "}
                {j.items.filter((i) => i.status === "done").length}/
                {j.items.length} saved ·{" "}
                {j.items.every((i) => i.status === "done")
                  ? "complete"
                  : j.expired
                    ? "expired"
                    : j.status}
              </span>
              <button
                className="text-link"
                disabled={busy}
                onClick={() => accept(j)}
              >
                Open progress
              </button>
            </div>
          ))}
        </div>
      )}
      {job && (
        <>
          <div className="section-heading">
            <h3>
              {job.items.filter((i) => i.status === "done").length} of{" "}
              {job.items.length} saved
            </h3>
            <span className="pill">
              {complete ? "Complete" : job.expired ? "Expired" : job.status}
            </span>
          </div>
          <p>
            Progress expires {new Date(job.expiresAt).toLocaleString()}. Reopen
            the matching private review file to edit or finish an item.
          </p>
          <div className="import-toolbar">
            {complete ? null : job.status === "active" ? (
              <>
                <button
                  className="site-secondary"
                  disabled={busy || job.expired}
                  onClick={() => void control("pause")}
                >
                  Pause job
                </button>
                <button
                  className="site-secondary"
                  disabled={busy || job.expired}
                  onClick={() => void control("cancel")}
                >
                  Cancel remaining work
                </button>
              </>
            ) : (
              <button
                className="site-secondary"
                disabled={busy || job.expired}
                onClick={() => void control("resume")}
              >
                Resume job
              </button>
            )}
          </div>
          <p className="subtle-note">
            Pausing or cancelling stops new writes and clears unused approvals.
            Already-started saves may finish. Check interrupted items before
            resuming; existing Notion records are preserved.
          </p>
          <div className="import-proposals">
            {job.items.map((item, index) => {
              const draft = proposals.find((p) => p.id === item.id);
              return (
                <article key={item.id} className="import-job-item">
                  <h4>{draft?.data.title ?? "Import item " + (index + 1)}</h4>
                  <p>
                    {item.status === "check"
                      ? "Save needs inspection"
                      : item.status}{" "}
                    · {item.attempts}/{item.attemptLimit} attempts
                    {item.leaseActive ? " · Save in progress" : ""}
                  </p>
                  {item.notBefore && (
                    <p>
                      Review another attempt after{" "}
                      {new Date(item.notBefore).toLocaleTimeString()}.
                    </p>
                  )}
                  {item.lastCode && (
                    <p className="subtle-note">{item.lastCode}</p>
                  )}
                  <div className="import-toolbar">
                    {draft &&
                      !["done", "running", "check"].includes(item.status) && (
                        <button
                          className="text-link"
                          disabled={
                            busy ||
                            job.status !== "active" ||
                            job.expired ||
                            item.attempts >= item.attemptLimit
                          }
                          onClick={() => onChoose(item.id)}
                        >
                          Review this idea
                        </button>
                      )}
                    {["running", "check"].includes(item.status) && (
                      <button
                        className="site-secondary"
                        disabled={busy || item.leaseActive}
                        onClick={() => void check(item.id)}
                      >
                        Check save status
                      </button>
                    )}
                    {item.recoverable && (
                      <button
                        className="site-secondary"
                        disabled={
                          busy ||
                          !draft ||
                          job.status !== "active" ||
                          job.expired
                        }
                        onClick={() => void reviewMissing(item.id)}
                      >
                        {["not_started", "idea_rejected"].includes(item.phase)
                          ? "Review stopped import"
                          : "Review missing source"}
                      </button>
                    )}
                    {item.ideaId && (
                      <Link
                        className="text-link"
                        href={"/ideas/" + item.ideaId}
                      >
                        Inspect canonical idea
                      </Link>
                    )}
                  </div>
                  {item.status === "check" &&
                    !item.recoverable &&
                    !item.leaseActive && (
                      <p className="subtle-note">
                        The outcome is not yet safe to retry. Check for a
                        confirmed result; if it stays unconfirmed, inspect the
                        original operation rather than creating another copy.
                      </p>
                    )}
                </article>
              );
            })}
          </div>
        </>
      )}
      {recovery && (
        <div
          className="notice import-job-review"
          role="region"
          aria-label="Review missing source"
        >
          <h3>
            {recovery.review.action === "import-recover-create"
              ? "Resume the stopped import"
              : "Finish the missing source"}
          </h3>
          <p>
            {recovery.review.action === "import-recover-create"
              ? "No idea write was dispatched. This resumes the exact idea and selected source shown below after your fresh approval."
              : "This preserves the existing idea and attaches only the originally approved source. It creates no second idea and calls no model."}
          </p>
          <dl className="change-list">
            {recovery.review.changes.map((c) => (
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
            Approval expires{" "}
            {new Date(recovery.review.expiresAt).toLocaleTimeString()}.
          </p>
          <button
            className="site-primary"
            disabled={busy}
            onClick={() => void finishMissing()}
          >
            {recovery.review.action === "import-recover-create"
              ? "Approve import recovery"
              : "Approve source recovery"}
          </button>
          <button
            className="site-secondary"
            disabled={busy}
            onClick={() => setRecovery(null)}
          >
            Keep inspecting
          </button>
        </div>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
