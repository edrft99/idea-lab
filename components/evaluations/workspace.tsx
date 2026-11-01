"use client";
import Link from "@/components/navigation-link";
import { SaveAssessment } from "./proposals";
import { useState, useEffect, useRef } from "react";
import { Download, Upload, Check, Save } from "lucide-react";
import { type IdeaDetail } from "@/lib/ideas/domain";
import {
  dimensions,
  dimensionLabels,
  defaultWeights,
  ratingSchema,
  weightSchema,
  potential,
  evaluationDraftSchema,
  evaluationCommandSchema,
  decodeDraftFile,
  draftFileSchema,
  type EvaluationDraft,
  type EvaluationCommand,
} from "@/lib/evaluations/model";
import { efforts, readinessOptions } from "@/lib/ideas/domain";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
type DraftState = Omit<EvaluationDraft, "ratings" | "confidence"> & {
  ratings: Record<(typeof dimensions)[number], number | null>;
  confidence: number | null;
};
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
};
const empty = (): DraftState => ({
  rubricVersion: "potential-v1",
  weights: { ...defaultWeights },
  ratings: {
    impact: null,
    alignment: null,
    feasibility: null,
    reusability: null,
    timing: null,
  },
  evidence: {
    impact: "",
    alignment: "",
    feasibility: "",
    reusability: "",
    timing: "",
  },
  rationale: "",
  benefits: "",
  risks: "",
  assumptions: "",
  effort: "Unknown",
  readiness: "Discovery",
  confidence: null,
  nextAction: "",
});
export function EvaluationWorkspace({ id }: { id?: string }) {
  return id ? <Bound key={id} id={id} /> : <Workbench />;
}
function Bound({ id }: { id: string }) {
  const resource = useResource<IdeaDetail>("/api/ideas/" + id);
  if (resource.error)
    return (
      <div className="page">
        <Failure error={resource.error} retry={resource.refresh} />
        <Link className="text-link" href="/evaluations">
          Open the offline scoring workbench
        </Link>
      </div>
    );
  if (!resource.data)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  return <Workbench key={resource.data.idea.revision} detail={resource.data} />;
}
function Workbench({ detail }: { detail?: IdeaDetail }) {
  const idea = detail?.idea,
    [draft, setDraft] = useState<DraftState>(empty),
    [ready, setReady] = useState(false),
    [apply, setApply] = useState(false),
    [replace, setReplace] = useState(false),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reviewIds, setReviewIds] = useState<string[]>([]),
    [notice, setNotice] = useState(""),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [command, setCommand] = useState<EvaluationCommand | null>(null),
    [uncertain, setUncertain] = useState(false),
    [saved, setSaved] = useState(false),
    [queued, setQueued] = useState(""),
    [loadedTarget, setLoadedTarget] = useState<{
      id: string;
      revision: string;
    } | null>(null);
  const file = useRef<HTMLInputElement>(null),
    inFlight = useRef(false);
  useEffect(() => setReady(true), []);
  const ratings = ratingSchema.safeParse(draft.ratings),
    weights = weightSchema.safeParse(draft.weights),
    score =
      ratings.success && weights.success
        ? potential(ratings.data, weights.data)
        : null;
  const locked =
    !ready || busy || Boolean(receipt) || uncertain || saved || !!queued;
  function change<K extends keyof DraftState>(key: K, value: DraftState[K]) {
    setDraft((v) => ({ ...v, [key]: value }));
    setError("");
    setReviewIds([]);
    setNotice("");
  }
  function validated() {
    const result = evaluationDraftSchema.safeParse(draft);
    if (!result.success)
      throw new Error(
        result.error.issues[0]?.path.join(" · ") +
          ": " +
          result.error.issues[0]?.message,
      );
    return result.data;
  }
  async function restore(selected: File | undefined) {
    if (!selected || locked) return;
    setBusy(true);
    setError("");
    try {
      if (selected.size > 100000)
        throw new Error("Choose a draft smaller than 100 KB.");
      let raw;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          await selected.arrayBuffer(),
        );
      } catch {
        throw new Error("Choose a UTF-8 evaluation draft.");
      }
      const parsed = decodeDraftFile(raw);
      if (idea && parsed.ideaId && parsed.ideaId !== idea.id)
        throw new Error("This draft belongs to a different idea.");
      if (
        idea &&
        parsed.inputRevision &&
        parsed.inputRevision !== idea.revision
      )
        throw new Error(
          "This draft was based on an older idea revision. Review its evidence separately before evaluating the current record.",
        );
      setDraft(parsed.draft);
      setLoadedTarget(
        parsed.ideaId && parsed.inputRevision
          ? { id: parsed.ideaId, revision: parsed.inputRevision }
          : null,
      );
      setApply(false);
      setReplace(false);
      setReason("");
      setNotice(
        "Draft restored locally. No approval or saved status was restored.",
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The draft could not be loaded.",
      );
    } finally {
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }
  function download() {
    setError("");
    try {
      const data = draftFileSchema.parse({
        format: "idea-lab-evaluation",
        version: 1,
        ideaId: idea?.id ?? loadedTarget?.id ?? null,
        inputRevision: idea?.revision ?? loadedTarget?.revision ?? null,
        draft: validated(),
      });
      const url = URL.createObjectURL(
          new Blob([JSON.stringify(data, null, 2)], {
            type: "application/json",
          }),
        ),
        a = document.createElement("a");
      a.href = url;
      a.download = "idea-lab-evaluation.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setNotice(
        "Draft downloaded. Keep it private; it includes your evidence and assessment, with no approval token.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Complete the assessment before downloading.",
      );
    }
  }
  async function review(event: React.FormEvent) {
    event.preventDefault();
    if (!idea || inFlight.current) return;
    setError("");
    setReviewIds([]);
    inFlight.current = true;
    setBusy(true);
    try {
      const next = evaluationCommandSchema.parse({
        ideaId: idea.id,
        expectedRevision: idea.revision,
        draft: validated(),
        applyToIdea: apply,
        replaceManualScore: replace,
        overrideReason: reason,
      });
      if (
        apply &&
        idea.scoreAuthority === "manual-approved" &&
        (!replace || !reason.trim())
      )
        throw new Error("Choose to replace the manual score and explain why.");
      const approved = await requestData<Receipt>("/api/evaluations/prepare", {
        method: "POST",
        body: JSON.stringify(next),
      });
      setCommand(next);
      setReceipt(approved);
    } catch (e) {
      if (e instanceof ApiFailure) setReviewIds(e.reviewIds);
      setError(
        e instanceof Error
          ? e.message
          : "The evaluation could not be reviewed.",
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
      await requestData("/api/evaluations/commit", {
        method: "POST",
        body: JSON.stringify({ command, approvalToken: receipt.approvalToken }),
      });
      setSaved(true);
      setUncertain(false);
      setReceipt(null);
    } catch (e) {
      const failure =
        e instanceof ApiFailure
          ? e
          : new ApiFailure(
              "WRITE_UNCERTAIN",
              "The result is unknown. Check this save before submitting another evaluation.",
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
  async function reconcile() {
    if (!receipt || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await requestData<{ status: string }>(
        "/api/evaluations/status",
        {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        },
      );
      if (result.status === "done") {
        setSaved(true);
        setUncertain(false);
        setReceipt(null);
      } else
        setError(
          "This save remains unconfirmed. Check Recent Saves before submitting another evaluation.",
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
    <div className="page import-page evaluation-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EVIDENCE BEFORE ENTHUSIASM</div>
          <h1>
            A considered score<span>.</span>
          </h1>
          <p>
            {idea
              ? idea.title
              : "Explore the rubric and prepare an assessment, even before connecting Notion."}
          </p>
        </div>
        <div className="large-score">
          <span>POTENTIAL</span>
          <strong>
            {score ?? "—"}
            <small>/100</small>
          </strong>
          <span>
            {weights.success
              ? "All five ratings required"
              : "Weights must total 100%"}
          </span>
        </div>
      </div>
      <div className="notice">
        <p>
          This is your manual assessment. No AI service is called. Effort and
          readiness stay separate from potential. Drafts stay in memory until
          downloaded; leaving this page can discard them.
        </p>
      </div>
      {idea ? (
        <section className="panel prose-panel">
          <h2>Current canonical record</h2>
          <Link className="text-link" href={"/ideas/" + idea.id + "/assess-ai"}>
            Request a selected-content AI assessment
          </Link>
          <p>{idea.summary}</p>
          <p>
            Active score: {idea.priorityScore ?? "Unrated"} ·{" "}
            {idea.scoreAuthority ?? "No evaluation selected"}
          </p>
          <Link className="text-link" href={"/ideas/" + idea.id}>
            Open full idea and history
          </Link>
        </section>
      ) : (
        <section className="panel prose-panel">
          <p>
            Local calculations and draft files work without a token. To save
            history, open an idea from the Explorer and choose Evaluate.
          </p>
          <Link className="text-link" href="/ideas">
            Choose a canonical idea
          </Link>
          {loadedTarget && (
            <p>
              This draft was linked to{" "}
              <Link
                className="text-link"
                href={"/ideas/" + loadedTarget.id + "/evaluate"}
              >
                an existing idea
              </Link>
              . The link and revision must be verified before saving.
            </p>
          )}
        </section>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
          {reviewIds.map((id) => (
            <Link
              className="text-link"
              key={id}
              href={"/review/assessments/" + id}
            >
              Inspect saved assessment
            </Link>
          ))}
        </div>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {saved ? (
        <section className="panel empty-state" role="status">
          <Check size={28} />
          <h2>Evaluation confirmed.</h2>
          <p>
            {apply
              ? "History and the active score were saved."
              : "Evaluation history was saved; the active score was left unchanged."}
          </p>
          <Link className="site-primary" href={"/ideas/" + idea!.id}>
            Open idea and evaluation history
          </Link>
        </section>
      ) : (
        <>
          <fieldset className="import-ready" disabled={locked}>
            <div className="import-toolbar">
              <button
                className="site-secondary"
                type="button"
                onClick={() => file.current?.click()}
              >
                <Upload size={15} />
                Load evaluation draft
              </button>
              <input
                ref={file}
                hidden
                type="file"
                accept=".json,application/json"
                aria-label="Evaluation draft file"
                onChange={(e) => void restore(e.target.files?.[0])}
              />
              <button
                className="site-secondary"
                type="button"
                onClick={download}
              >
                <Download size={15} />
                Download assessment draft
              </button>
            </div>
          </fieldset>
          <form method="post" onSubmit={review}>
            <fieldset className="import-ready" disabled={locked}>
              <section className="panel prose-panel">
                <h2>Five dimensions of potential</h2>
                <p>
                  Rate each from 1 (low) to 5 (high), and name the evidence or
                  uncertainty behind your choice.
                </p>
                <div className="evaluation-dimensions">
                  {dimensions.map((k) => (
                    <article className="evaluation-dimension" key={k}>
                      <h3>{dimensionLabels[k]}</h3>
                      <div className="editor-select-grid">
                        <label>
                          Rating
                          <select
                            aria-label={dimensionLabels[k] + " rating"}
                            value={draft.ratings[k] ?? ""}
                            onChange={(e) =>
                              change("ratings", {
                                ...draft.ratings,
                                [k]: e.target.value
                                  ? Number(e.target.value)
                                  : null,
                              })
                            }
                          >
                            <option value="">Unrated</option>
                            {[1, 2, 3, 4, 5].map((n) => (
                              <option value={n} key={n}>
                                {n}/5
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          Weight (%)
                          <input
                            aria-label={dimensionLabels[k] + " weight"}
                            type="number"
                            min={0}
                            max={100}
                            step="any"
                            value={
                              Number.isFinite(draft.weights[k])
                                ? draft.weights[k]
                                : ""
                            }
                            onChange={(e) => {
                              change("weights", {
                                ...draft.weights,
                                [k]:
                                  e.target.value === ""
                                    ? NaN
                                    : Number(e.target.value),
                              });
                              if (draft.rubricVersion === "potential-v1")
                                change("rubricVersion", "potential-custom-v1");
                            }}
                          />
                        </label>
                      </div>
                      <label>
                        Evidence and reasoning
                        <textarea
                          aria-label={dimensionLabels[k] + " evidence"}
                          maxLength={1200}
                          rows={2}
                          value={draft.evidence[k]}
                          onChange={(e) =>
                            change("evidence", {
                              ...draft.evidence,
                              [k]: e.target.value,
                            })
                          }
                        />
                      </label>
                    </article>
                  ))}
                </div>
                <p className="subtle-note">
                  Potential = Σ ((rating − 1) × weight ÷ 4). Weights total 100%;
                  all 1s score 0 and all 5s score 100. Current weights:{" "}
                  {Object.values(draft.weights)
                    .filter(Number.isFinite)
                    .reduce((a, b) => a + b, 0)}
                  %.
                </p>
                <label>
                  Rubric version
                  <input
                    maxLength={100}
                    value={draft.rubricVersion}
                    onChange={(e) => change("rubricVersion", e.target.value)}
                  />
                </label>
              </section>
              <section className="panel prose-panel">
                <h2>Make the reasoning inspectable</h2>
                {(
                  [
                    { key: "rationale", label: "Overall rationale" },
                    { key: "benefits", label: "Potential benefits" },
                    { key: "risks", label: "Major risks" },
                    { key: "assumptions", label: "Assumptions" },
                    { key: "nextAction", label: "Recommended next action" },
                  ] as const
                ).map((f) => (
                  <label key={f.key}>
                    {f.label}
                    <textarea
                      rows={3}
                      maxLength={2000}
                      value={draft[f.key]}
                      onChange={(e) => change(f.key, e.target.value)}
                    />
                  </label>
                ))}
                <div className="editor-select-grid">
                  <label>
                    Estimated effort
                    <select
                      value={draft.effort}
                      aria-label="Evaluation effort"
                      onChange={(e) =>
                        change(
                          "effort",
                          e.target.value as EvaluationDraft["effort"],
                        )
                      }
                    >
                      {efforts.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Readiness
                    <select
                      value={draft.readiness}
                      aria-label="Evaluation readiness"
                      onChange={(e) =>
                        change(
                          "readiness",
                          e.target.value as EvaluationDraft["readiness"],
                        )
                      }
                    >
                      {readinessOptions.map((v) => (
                        <option key={v}>{v}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <label>
                  Assessment confidence (%)
                  <input
                    type="number"
                    min={0}
                    max={100}
                    step="any"
                    value={
                      draft.confidence === null ? "" : draft.confidence * 100
                    }
                    onChange={(e) =>
                      change(
                        "confidence",
                        e.target.value === ""
                          ? null
                          : Number(e.target.value) / 100,
                      )
                    }
                  />
                </label>
              </section>
              {idea && (
                <section className="panel prose-panel">
                  <h2>Choose what this save changes</h2>
                  <label className="turn-select">
                    <input
                      type="checkbox"
                      checked={apply}
                      onChange={(e) => setApply(e.target.checked)}
                    />
                    Use this evaluation as the active score
                  </label>
                  <p>
                    Every save appends history. Selecting an active score also
                    changes its ratings, confidence and latest evaluation; idea
                    descriptions, lifecycle, effort, readiness and next action
                    remain unchanged.
                  </p>
                  {apply && idea.scoreAuthority === "manual-approved" && (
                    <>
                      <label className="turn-select">
                        <input
                          type="checkbox"
                          checked={replace}
                          onChange={(e) => setReplace(e.target.checked)}
                        />
                        Replace the manually approved score
                      </label>
                      <label>
                        Reason for manual override
                        <textarea
                          rows={3}
                          maxLength={2000}
                          value={reason}
                          onChange={(e) => setReason(e.target.value)}
                        />
                      </label>
                    </>
                  )}
                  <button className="site-primary" type="submit">
                    <Save size={15} />
                    {busy ? "Preparing…" : "Review evaluation save"}
                  </button>
                </section>
              )}
            </fieldset>
          </form>
          {idea && !receipt && (
            <SaveAssessment
              ideaId={idea.id}
              inputRevision={idea.revision}
              draft={draft}
              onQueued={setQueued}
            />
          )}
          {queued && (
            <p role="status">
              Assessment saved for review.{" "}
              <Link
                className="text-link"
                href={"/review/assessments/" + queued}
              >
                Open saved assessment
              </Link>
            </p>
          )}
          {receipt && (
            <section className="panel prose-panel approval-panel">
              <h2>Review this evaluation</h2>
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
                {new Date(receipt.expiresAt).toLocaleTimeString()}. No merge,
                deletion or automatic reevaluation is part of this save.
              </p>
              {uncertain ? (
                <button
                  className="site-primary"
                  onClick={reconcile}
                  disabled={busy}
                >
                  Check evaluation save
                </button>
              ) : (
                <>
                  <button
                    className="site-primary"
                    onClick={save}
                    disabled={busy}
                  >
                    {busy ? "Saving…" : "Approve evaluation save"}
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
                    Back to evaluation editing
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
    </div>
  );
}
