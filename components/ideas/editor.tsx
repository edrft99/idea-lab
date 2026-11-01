"use client";
import type { ProposalDecision } from "@/lib/proposals/model";
import { type ImportSource } from "@/lib/imports/provenance";
import Link from "@/components/navigation-link";
import { useState, useEffect, useRef } from "react";
import { ArrowLeft, Check, Save, RotateCcw } from "lucide-react";
import {
  categories,
  statuses,
  efforts,
  readinessOptions,
  editableIdeaSchema,
  editable,
  type EditableIdea,
  type IdeaDetail,
  type IdeaCommand,
  type Idea,
} from "@/lib/ideas/domain";
import { requestData, ApiFailure } from "./use-resource";
import { Loading, Failure } from "./states";
type Approval = {
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
  action: string;
};
const blank: EditableIdea = {
  title: "",
  summary: "",
  problem: "",
  solution: "",
  audience: "",
  expectedValue: "",
  context: "",
  category: "AI & Agents",
  status: "Inbox",
  effort: "Unknown",
  readiness: "Discovery",
  nextAction: "",
  projectUrl: "",
};
export function IdeaEditor({
  id,
  initialDraft,
  source,
  onDraftChange,
  onSaved,
  proposalContext,
  draftOnly = false,
  importJob,
  onImportProgress,
}: {
  id?: string;
  draftOnly?: boolean;
  importJob?: {
    jobId: string;
    itemId: string;
    stopped: boolean;
    blocked: boolean;
  };
  onImportProgress?: () => void;
  proposalContext?: { id: string; revision: string };
  initialDraft?: EditableIdea;
  source?: ImportSource;
  onDraftChange?: (data: EditableIdea) => void;
  onSaved?: (idea: Idea) => void;
}) {
  const [interactive, setInteractive] = useState(false);
  useEffect(() => setInteractive(true), []);
  const [form, setForm] = useState<EditableIdea>(initialDraft ?? blank),
    [revision, setRevision] = useState(""),
    [loaded, setLoaded] = useState(!id),
    [loadError, setLoadError] = useState<ApiFailure | null>(null),
    [error, setError] = useState<ApiFailure | null>(null),
    [approval, setApproval] = useState<Approval | null>(null),
    [reviewedCommand, setReviewedCommand] = useState<
      IdeaCommand | ProposalDecision | null
    >(null),
    [busy, setBusy] = useState(false),
    [saved, setSaved] = useState<Idea | null>(null),
    [uncertain, setUncertain] = useState(false),
    [decisionReason, setDecisionReason] = useState("");
  const inFlight = useRef(false);
  useEffect(() => {
    if (importJob?.stopped && !uncertain) {
      setApproval(null);
      setReviewedCommand(null);
    }
  }, [importJob?.stopped, uncertain]);
  useEffect(() => {
    if (!id) return;
    setLoaded(false);
    setLoadError(null);
    let current = true;
    requestData<IdeaDetail>("/api/ideas/" + id)
      .then((data) => {
        if (current) {
          setForm(editable(data.idea));
          setRevision(data.idea.revision);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (current) setLoadError(e);
      });
    return () => {
      current = false;
    };
  }, [id]);
  function change(key: keyof EditableIdea, value: string) {
    const next = { ...form, [key]: value };
    setForm(next);
    onDraftChange?.(next);
    setApproval(null);
    setReviewedCommand(null);
    setError(null);
  }
  function command(): IdeaCommand | ProposalDecision {
    if (proposalContext)
      return {
        decision: "Approve",
        proposalId: proposalContext.id,
        proposalRevision: proposalContext.revision,
        data: form,
        reason: decisionReason,
      };
    return id
      ? { action: "update", id, expectedRevision: revision, data: form }
      : { action: "create", data: form, ...(source ? { source } : {}) };
  }
  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (draftOnly) return;
    if (inFlight.current) return;
    if (proposalContext && !decisionReason.trim()) {
      setError(
        new ApiFailure(
          "INVALID_PROPOSAL",
          "Explain why this proposal should be accepted.",
          400,
        ),
      );
      return;
    }
    const parsed = editableIdeaSchema.safeParse(form);
    if (!parsed.success) {
      setError(
        new ApiFailure(
          "INVALID_IDEA",
          parsed.error.issues[0]?.message ?? "Check the form fields.",
          400,
        ),
      );
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const proposed = { ...command(), data: parsed.data } as
        IdeaCommand | ProposalDecision;
      const next = await requestData<Approval>(
        proposalContext
          ? "/api/proposals/decision/prepare"
          : importJob
            ? "/api/imports/jobs/" + importJob.jobId + "/prepare"
            : "/api/approvals",
        {
          method: "POST",
          body: JSON.stringify(
            importJob && !proposalContext
              ? { itemId: importJob.itemId, command: proposed }
              : proposed,
          ),
        },
      );
      setReviewedCommand(proposed);
      setApproval(next);
      if (importJob) onImportProgress?.();
    } catch (e) {
      setError(
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "UNAVAILABLE",
              "The changes could not be prepared.",
              503,
            ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (!approval || !reviewedCommand || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await requestData<{ idea: Idea; replayed: boolean }>(
        proposalContext
          ? "/api/proposals/decision/commit"
          : importJob
            ? "/api/imports/jobs/" + importJob.jobId + "/commit"
            : "/api/ideas/commit",
        {
          method: "POST",
          body: JSON.stringify({
            ...(importJob && !proposalContext
              ? { itemId: importJob.itemId }
              : {}),
            command: reviewedCommand,
            approvalToken: approval.approvalToken,
          }),
        },
      );
      setSaved(result.idea);
      onSaved?.(result.idea);
      setApproval(null);
      setUncertain(false);
    } catch (e) {
      const failure =
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "WRITE_UNCERTAIN",
              "The request ended before the save was confirmed. Check its status before another save.",
              503,
              true,
            );
      setError(failure);
      if (failure.uncertain || failure.code === "RECONCILIATION_REQUIRED")
        setUncertain(true);
      else if (failure.code !== "SAVE_BUSY") {
        setApproval(null);
        setReviewedCommand(null);
      }
    } finally {
      inFlight.current = false;
      setBusy(false);
      if (importJob) onImportProgress?.();
    }
  }
  async function reconcile() {
    if (!approval || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      const result =
        importJob && !proposalContext
          ? await requestData<import("@/lib/imports/job-model").ImportJobView>(
              "/api/imports/jobs/" + importJob.jobId + "/check",
              {
                method: "POST",
                body: JSON.stringify({ itemId: importJob.itemId }),
              },
            ).then((job) => {
              const item = job.items.find((i) => i.id === importJob.itemId);
              return {
                status: item?.status ?? "check",
                ideaId: item?.ideaId ?? null,
              };
            })
          : await requestData<{
              status: string;
              ideaId: string | null;
            }>(
              proposalContext
                ? "/api/proposals/decision/status"
                : "/api/operations/status",
              {
                method: "POST",
                body: JSON.stringify({ approvalToken: approval.approvalToken }),
              },
            );
      if (result.status === "done" && result.ideaId) {
        const detail = await requestData<IdeaDetail>(
          "/api/ideas/" + result.ideaId,
        );
        setSaved(detail.idea);
        onSaved?.(detail.idea);
        setApproval(null);
        setUncertain(false);
      } else
        setError(
          new ApiFailure(
            "RECONCILIATION_REQUIRED",
            "The save is still unconfirmed. Keep this page open and check again. Do not create another copy.",
            409,
            true,
          ),
        );
    } catch (e) {
      setError(
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "UNAVAILABLE",
              "The save status could not be checked.",
              503,
              true,
            ),
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
      if (importJob) onImportProgress?.();
    }
  }
  return (
    <div className="page editor-page">
      <Link href={id ? "/ideas/" + id : "/ideas"} className="back-link">
        <ArrowLeft size={15} />
        Back to your ideas
      </Link>
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            {id
              ? "A THOUGHT, REFINED"
              : source
                ? "FROM EVIDENCE TO POSSIBILITY"
                : "START WITH A SPARK"}
          </div>
          <h1>
            {id
              ? "Shape the next step"
              : source
                ? "Review your imported idea"
                : "What’s on your mind"}
            <span>{id ? "." : "?"}</span>
          </h1>
          <p>Review the exact changes, then approve saving them to Notion.</p>
        </div>
      </div>
      {source && (
        <section className="panel prose-panel import-evidence">
          <span className="tiny-label">
            {source.system} · {source.role} ·{" "}
            {proposalContext ? "PENDING NOTION PROPOSAL" : "UNSAVED PROPOSAL"}
          </span>
          <h2>Selected source evidence</h2>
          <p className="preserve-text">{source.evidence}</p>
          <small>
            {source.locator} ·{" "}
            {source.conversationDate ?? "Conversation date unknown"}
          </small>
          <p>
            {draftOnly
              ? "These edits remain local. The selected evidence and AI origin are included only when you review proposal storage above; editing makes no further AI request."
              : proposalContext
                ? "This selected evidence is preserved in the saved Notion proposal. The decision uses this source and the reviewed fields. No AI provider is called."
                : "Only this evidence and the reviewed fields will be sent to Idea Lab when you request a review. No AI provider is called."}
          </p>
        </section>
      )}
      {loadError ? (
        <Failure error={loadError} retry={() => window.location.reload()} />
      ) : !loaded ? (
        <Loading />
      ) : saved ? (
        <section className="panel empty-state" role="status">
          <Check size={30} />
          <h2>Saved to your collection.</h2>
          <p>{saved.title}</p>
          <Link className="site-primary" href={"/ideas/" + saved.id}>
            Open saved idea
          </Link>
          {saved.url && (
            <a
              className="text-link"
              href={saved.url}
              target="_blank"
              rel="noreferrer"
            >
              Open canonical Notion record
            </a>
          )}
        </section>
      ) : (
        <div className="editor-columns">
          <form method="post" onSubmit={review} className="panel capture-form">
            <fieldset
              disabled={
                !interactive ||
                busy ||
                Boolean(approval) ||
                uncertain ||
                importJob?.stopped ||
                importJob?.blocked
              }
            >
              <label>
                Title
                <input
                  name="title"
                  maxLength={200}
                  required
                  value={form.title}
                  onChange={(e) => change("title", e.target.value)}
                  placeholder="A small name for a big possibility"
                />
              </label>
              <label>
                Summary
                <textarea
                  name="summary"
                  rows={3}
                  required
                  maxLength={2000}
                  value={form.summary}
                  onChange={(e) => change("summary", e.target.value)}
                  placeholder="What would you create, and why would it matter?"
                />
              </label>
              <div className="editor-select-grid">
                {[
                  { key: "category", label: "Category", options: categories },
                  { key: "status", label: "Status", options: statuses },
                  {
                    key: "effort",
                    label: "Estimated effort",
                    options: efforts,
                  },
                  {
                    key: "readiness",
                    label: "Readiness",
                    options: readinessOptions,
                  },
                ].map((f) => (
                  <label key={f.key}>
                    {f.label}
                    <select
                      aria-label={f.label}
                      value={form[f.key as keyof EditableIdea]}
                      onChange={(e) =>
                        change(f.key as keyof EditableIdea, e.target.value)
                      }
                    >
                      {f.options.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              {[
                { key: "problem", label: "Problem statement" },
                { key: "solution", label: "Proposed solution" },
                { key: "audience", label: "Intended audience" },
                { key: "expectedValue", label: "Expected value" },
                { key: "context", label: "Relevant context" },
                { key: "nextAction", label: "Next action" },
              ].map((f) => (
                <label key={f.key}>
                  {f.label}
                  <textarea
                    rows={f.key === "problem" || f.key === "solution" ? 3 : 2}
                    maxLength={6000}
                    value={form[f.key as keyof EditableIdea]}
                    onChange={(e) =>
                      change(f.key as keyof EditableIdea, e.target.value)
                    }
                  />
                </label>
              ))}
              <label>
                Project URL
                <input
                  type="url"
                  value={form.projectUrl}
                  onChange={(e) => change("projectUrl", e.target.value)}
                  placeholder="https://…"
                />
              </label>
              {proposalContext && (
                <label>
                  Acceptance reason
                  <textarea
                    rows={2}
                    required
                    maxLength={2000}
                    value={decisionReason}
                    onChange={(e) => {
                      setDecisionReason(e.target.value);
                      setApproval(null);
                      setReviewedCommand(null);
                      setError(null);
                    }}
                  />
                </label>
              )}
            </fieldset>
            {!draftOnly && !approval && !uncertain && (
              <button
                type="submit"
                className="site-primary"
                disabled={
                  !interactive ||
                  busy ||
                  importJob?.stopped ||
                  importJob?.blocked
                }
              >
                <Save size={15} />
                {busy ? "Preparing review…" : "Review changes"}
              </button>
            )}
            <p className="subtle-note">
              Changing status to Archived preserves the record. Scores,
              evaluations and source links are preserved by this form.
            </p>
          </form>
          <aside className="panel prose-panel approval-panel">
            {draftOnly && (
              <p>
                These edits remain a local proposal. Use the separate
                proposal-storage review above before accepting it into your
                collection.
              </p>
            )}
            <h2>
              {approval ? "Review before saving" : "You stay in control."}
            </h2>
            {approval ? (
              <>
                <p>
                  {approval.action === "create"
                    ? "A new canonical idea will be created in Notion."
                    : "Only the fields listed below will change in Notion."}
                </p>
                <dl className="change-list">
                  {approval.changes.map((c) => (
                    <div key={c.field}>
                      <dt>{c.field}</dt>
                      <dd>
                        {c.before && <del>{c.before}</del>}
                        <span>{c.after || "(cleared)"}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
                <p className="subtle-note">
                  Approval expires at{" "}
                  {new Date(approval.expiresAt).toLocaleTimeString()}. No merge
                  or deletion is part of this action.
                </p>
                {uncertain ? (
                  <button
                    className="site-primary"
                    type="button"
                    onClick={reconcile}
                    disabled={busy}
                  >
                    Check save status
                  </button>
                ) : (
                  <>
                    <button
                      className="site-primary"
                      type="button"
                      onClick={save}
                      disabled={
                        busy || importJob?.stopped || importJob?.blocked
                      }
                    >
                      <Check size={15} />
                      {busy ? "Saving…" : "Approve & save to Notion"}
                    </button>
                    <button
                      type="button"
                      className="site-secondary mt-button"
                      disabled={busy}
                      onClick={() => {
                        setApproval(null);
                        setReviewedCommand(null);
                        setError(null);
                      }}
                    >
                      <RotateCcw size={14} />
                      Back to editing
                    </button>
                  </>
                )}
              </>
            ) : (
              <p>
                Nothing is written to Notion when you type or request a review.
                Saving requires your explicit approval of the changes.
              </p>
            )}
            {uncertain && (
              <Link className="text-link" href="/settings">
                Open Recent Saves
              </Link>
            )}
            {error && (
              <div className="form-error" role="alert">
                {error.message}
                {error.canonicalIdeaIds.map((recordId) => (
                  <Link
                    key={recordId}
                    className="text-link"
                    href={"/ideas/" + recordId}
                  >
                    Inspect canonical idea
                  </Link>
                ))}
                {error.reviewIds.map((reviewId) => (
                  <Link
                    key={reviewId}
                    className="text-link"
                    href={"/review/proposals/" + reviewId}
                  >
                    Open saved extraction proposal
                  </Link>
                ))}
                {error.code === "STALE_IDEA" && (
                  <Link className="text-link" href={"/ideas/" + id}>
                    Reload the current record
                  </Link>
                )}
              </div>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
