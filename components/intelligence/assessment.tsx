"use client";
import Link from "@/components/navigation-link";
import { useState, useRef } from "react";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
import type { IdeaDetail } from "@/lib/ideas/domain";
import {
  selectedFields,
  aiEvaluationRequestSchema,
  aiResultSchema,
  type AIResult,
  type AIEvaluationRequest,
} from "@/lib/intelligence/model";
import {
  defaultWeights,
  dimensionLabels,
  dimensions,
  type EvaluationDraft,
} from "@/lib/evaluations/model";
import { redact } from "@/lib/imports/staging";
import {
  SaveAssessment,
  AssessmentEvidence,
} from "@/components/evaluations/proposals";
type Profile = {
  enabled: boolean;
  message?: string;
  endpoint?: string;
  deployment?: string;
  retentionNotice?: string;
  requestsPerHour?: number;
};
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  command: AIEvaluationRequest;
  changes: { field: string; before: string; after: string }[];
};
export function AIConfiguration() {
  const r = useResource<Profile>("/api/ai/status");
  return (
    <section className="panel prose-panel mt-panel">
      <h2>AI model connection</h2>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.enabled ? (
        <>
          <p>Configured deployment: {r.data.deployment}</p>
          <p className="preserve-text">{r.data.endpoint}</p>
          <p className="preserve-text">{r.data.retentionNotice}</p>
          <p>
            Requests require selected content and a separate transmission
            approval. Credentials stay in protected server settings.
          </p>
        </>
      ) : (
        <p>{r.data.message}</p>
      )}
    </section>
  );
}
export function AIAssessment({ id }: { id: string }) {
  const resource = useResource<IdeaDetail>("/api/ideas/" + id),
    profile = useResource<Profile>("/api/ai/status");
  if (resource.error)
    return (
      <div className="page">
        <Failure error={resource.error} retry={resource.refresh} />
      </div>
    );
  if (!resource.data || (!profile.data && !profile.error))
    return (
      <div className="page">
        <Loading />
      </div>
    );
  if (profile.error)
    return (
      <div className="page">
        <Failure error={profile.error} retry={profile.refresh} />
      </div>
    );
  return (
    <AIWorkbench
      key={resource.data.idea.revision}
      detail={resource.data}
      profile={profile.data!}
    />
  );
}
function AIWorkbench({
  detail,
  profile,
}: {
  detail: IdeaDetail;
  profile: Profile;
}) {
  const idea = detail.idea,
    [selection, setSelection] = useState<
      Partial<Record<(typeof selectedFields)[number], string>>
    >({}),
    [weights, setWeights] = useState({ ...defaultWeights }),
    [rubric, setRubric] = useState("potential-v1"),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [result, setResult] = useState<AIResult | null>(null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [terminal, setTerminal] = useState(false),
    [message, setMessage] = useState(""),
    [error, setError] = useState(""),
    [queued, setQueued] = useState("");
  const running = useRef(false),
    file = useRef<HTMLInputElement>(null),
    locked = busy || !!receipt || !!result;
  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    setError("");
    setMessage("");
    const parsed = aiEvaluationRequestSchema.safeParse({
      ideaId: idea.id,
      inputRevision: idea.revision,
      selection,
      rubricVersion: rubric,
      weights,
    });
    if (!parsed.success) {
      setError(
        parsed.error.issues[0]?.message ?? "Select excerpts and valid weights.",
      );
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      setReceipt(
        await requestData<Receipt>("/api/ai/evaluations/prepare", {
          method: "POST",
          body: JSON.stringify(parsed.data),
        }),
      );
      setTerminal(false);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Transmission review is unavailable.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (!receipt || running.current) return;
    running.current = true;
    setBusy(true);
    setUncertain(true);
    setError("");
    try {
      const response = await requestData<{ result: AIResult }>(
        "/api/ai/evaluations/commit",
        {
          method: "POST",
          body: JSON.stringify({
            command: receipt.command,
            approvalToken: receipt.approvalToken,
          }),
        },
      );
      const parsed = aiResultSchema.parse(response.result);
      setResult(parsed);
      setReceipt(null);
      setUncertain(false);
      setMessage(
        "AI assessment received. Nothing has been saved in Notion or applied to the active score.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No result was confirmed. Check request status before another request.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!receipt || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await requestData<{ status: string; message: string }>(
        "/api/ai/evaluations/status",
        {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        },
      );
      setMessage(state.message);
      setTerminal(["done", "failed", "pending"].includes(state.status));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The request state is unavailable.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "idea-lab-ai-assessment.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore(selected?: File) {
    if (!selected || busy || receipt) return;
    setError("");
    try {
      if (selected.size > 100000)
        throw new Error("Choose a private AI assessment smaller than 100 KB.");
      const value = aiResultSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await selected.arrayBuffer(),
          ),
        ),
      );
      if (value.ideaId !== idea.id || value.inputRevision !== idea.revision)
        throw new Error(
          "This result belongs to another idea or input revision.",
        );
      setResult(value);
      setMessage(
        "Private result loaded locally. Its server proof is verified before proposal storage.",
      );
    } catch {
      setError("This result is invalid or refers to another idea/revision.");
    } finally {
      if (file.current) file.current.value = "";
    }
  }
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">SELECT, REVIEW, THEN ASK</div>
          <h1>
            A second perspective<span>.</span>
          </h1>
          <p>{idea.title}</p>
        </div>
      </div>
      <Link className="text-link" href={"/ideas/" + idea.id}>
        Back to the canonical idea
      </Link>
      <p className="notice">
        AI output is a proposal. Manual scores and history change only through a
        separate reviewed save. Excerpts and results stay in memory unless
        downloaded or explicitly saved.
      </p>
      {!profile.enabled && !result ? (
        <section className="panel prose-panel">
          <h2>AI assessment is not configured</h2>
          <p>{profile.message}</p>
          <Link
            className="site-primary"
            href={"/ideas/" + idea.id + "/evaluate"}
          >
            Open manual evaluation
          </Link>
        </section>
      ) : (
        <>
          {!result && (
            <form method="post" onSubmit={prepare}>
              <fieldset className="import-ready" disabled={locked}>
                <section className="panel prose-panel">
                  <h2>Choose the evidence to send</h2>
                  <p>
                    No fields are selected by default. Edit or redact each
                    selected excerpt before review. Sources, conversations,
                    scores, URLs and evaluation history are excluded.
                  </p>
                  {selectedFields.map((k) => (
                    <div key={k}>
                      <label className="turn-select">
                        <input
                          type="checkbox"
                          aria-label={"Select " + k}
                          checked={selection[k] !== undefined}
                          onChange={(e) =>
                            setSelection((v) => {
                              const next = { ...v };
                              if (e.target.checked)
                                next[k] = redact(String(idea[k] ?? "")).slice(
                                  0,
                                  3000,
                                );
                              else delete next[k];
                              return next;
                            })
                          }
                        />
                        {k}
                      </label>
                      {selection[k] !== undefined && (
                        <label>
                          {k} excerpt
                          <textarea
                            aria-label={k + " excerpt"}
                            rows={3}
                            maxLength={3000}
                            value={selection[k]}
                            onChange={(e) =>
                              setSelection((v) => ({
                                ...v,
                                [k]: e.target.value,
                              }))
                            }
                          />
                        </label>
                      )}
                    </div>
                  ))}
                </section>
                <section className="panel prose-panel">
                  <h2>Rubric and destination</h2>
                  <p>
                    {profile.endpoint} · {profile.deployment}
                  </p>
                  <p className="preserve-text">{profile.retentionNotice}</p>
                  <label>
                    AI rubric version
                    <input
                      maxLength={100}
                      value={rubric}
                      onChange={(e) => setRubric(e.target.value)}
                    />
                  </label>
                  {dimensions.map((k) => (
                    <label key={k}>
                      {dimensionLabels[k]} weight (%)
                      <input
                        aria-label={"AI " + k + " weight"}
                        type="number"
                        min={0}
                        max={100}
                        step="any"
                        value={Number.isFinite(weights[k]) ? weights[k] : ""}
                        onChange={(e) => {
                          setWeights((v) => ({
                            ...v,
                            [k]: Number(e.target.value),
                          }));
                          if (rubric === "potential-v1")
                            setRubric("potential-custom-v1");
                        }}
                      />
                    </label>
                  ))}
                  <button className="site-primary" type="submit">
                    Review AI transmission
                  </button>
                </section>
              </fieldset>
            </form>
          )}
          {receipt && (
            <section className="panel prose-panel approval-panel">
              <h2>Review this AI request</h2>
              <dl className="change-list">
                {receipt.changes.map((c) => (
                  <div key={c.field}>
                    <dt>{c.field}</dt>
                    <dd>
                      <span className="preserve-text">{c.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Consent expires at{" "}
                {new Date(receipt.expiresAt).toLocaleTimeString()}.
              </p>
              {uncertain ? (
                <>
                  <button
                    className="site-secondary"
                    disabled={busy}
                    onClick={check}
                  >
                    Check AI request status
                  </button>
                  {terminal && (
                    <button
                      className="site-secondary mt-button"
                      disabled={busy}
                      onClick={() => {
                        setReceipt(null);
                        setUncertain(false);
                        setTerminal(false);
                        setMessage(
                          "A new transmission requires a fresh review and may incur another provider charge.",
                        );
                      }}
                    >
                      Review a new request
                    </button>
                  )}
                </>
              ) : (
                <>
                  <button
                    className="site-primary"
                    disabled={busy}
                    onClick={send}
                  >
                    Send selected excerpts for AI assessment
                  </button>
                  <button
                    className="site-secondary mt-button"
                    disabled={busy}
                    onClick={() => setReceipt(null)}
                  >
                    Back to excerpt selection
                  </button>
                </>
              )}
            </section>
          )}
          {result && (
            <>
              <section className="panel prose-panel">
                <h2>Unapproved AI assessment</h2>
                <p>
                  {result.resolvedModel} · deployment {result.deployment} ·
                  prompt {result.promptVersion}
                </p>
                <p>
                  Only the selected excerpts were submitted. Review assumptions
                  and evidence before saving.
                </p>
                <button className="site-secondary" onClick={download}>
                  Download private AI result
                </button>
              </section>
              <AssessmentEvidence draft={result.draft} />
              <SaveAssessment
                ideaId={idea.id}
                inputRevision={result.inputRevision}
                draft={result.draft}
                ai={result}
                onQueued={setQueued}
              />
              {queued && (
                <Link
                  className="site-primary"
                  href={"/review/assessments/" + queued}
                >
                  Open saved AI assessment proposal
                </Link>
              )}
            </>
          )}
        </>
      )}
      {!receipt && (
        <section className="panel prose-panel mt-panel">
          <button
            className="site-secondary"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            Load private AI result
          </button>
          <input
            ref={file}
            hidden
            type="file"
            accept=".json,application/json"
            aria-label="Private AI result file"
            onChange={(e) => void restore(e.target.files?.[0])}
          />
        </section>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
    </div>
  );
}
