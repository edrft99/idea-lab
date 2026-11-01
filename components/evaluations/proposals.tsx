"use client";
import type { AIResult } from "@/lib/intelligence/model";
import Link from "@/components/navigation-link";
import { useState } from "react";
import { ReviewedAction } from "@/components/proposals/action";
import { useResource } from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
import type { IdeaDetail } from "@/lib/ideas/domain";
import type { AssessmentProposal } from "@/lib/evaluations/proposal-model";
import {
  evaluationDraftSchema,
  dimensions,
  dimensionLabels,
  potential,
  type EvaluationDraft,
} from "@/lib/evaluations/model";
const reviewPath = "/review/assessments/";
export function SaveAssessment({
  ideaId,
  inputRevision,
  draft,
  ai,
  onQueued,
}: {
  ideaId: string;
  inputRevision: string;
  draft: unknown;
  ai?: AIResult;
  onQueued: (id: string) => void;
}) {
  const [note, setNote] = useState(""),
    [reconsider, setReconsider] = useState(false),
    [why, setWhy] = useState("");
  const parsed = evaluationDraftSchema.safeParse(draft);
  return (
    <section className="panel prose-panel mt-panel">
      <h2>Keep this assessment for later review</h2>
      <p>
        Save a Pending proposal with its evidence, rubric and current idea
        snapshot. Accepting it into evaluation history or changing the active
        score requires another approval.
      </p>
      {!parsed.success ? (
        <p>
          Complete all ratings, evidence and reasoning to review proposal
          storage.
        </p>
      ) : (
        <ReviewedAction
          base="/api/assessment-proposals/store"
          reviewPath={reviewPath}
          input={{
            ideaId,
            inputRevision,
            draft: parsed.data,
            ...(ai ? { ai } : {}),
            note,
            reconsider,
            reconsiderReason: why,
          }}
          label="Review assessment storage"
          approvalLabel="Approve saving the pending assessment"
          onDone={onQueued}
        >
          <label>
            Assessment queue note
            <textarea
              required
              maxLength={2000}
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <label className="turn-select">
            <input
              type="checkbox"
              checked={reconsider}
              onChange={(e) => setReconsider(e.target.checked)}
            />
            Explicitly reconsider a prior rejection of this exact assessment
          </label>
          {reconsider && (
            <label>
              Assessment reconsideration reason
              <textarea
                required
                maxLength={2000}
                rows={2}
                value={why}
                onChange={(e) => setWhy(e.target.value)}
              />
            </label>
          )}
        </ReviewedAction>
      )}
    </section>
  );
}
export function AssessmentEvidence({ draft }: { draft: EvaluationDraft }) {
  return (
    <section className="panel prose-panel">
      <h2>
        Proposed assessment · {potential(draft.ratings, draft.weights)}/100
        potential
      </h2>
      <p>
        Rubric: {draft.rubricVersion} · effort: {draft.effort} · readiness:{" "}
        {draft.readiness} · {Math.round(draft.confidence * 100)}% confidence
      </p>
      <dl className="change-list">
        {dimensions.map((k) => (
          <div key={k}>
            <dt>
              {dimensionLabels[k]} · {draft.ratings[k]}/5 · {draft.weights[k]}%
            </dt>
            <dd>
              <span className="preserve-text">{draft.evidence[k]}</span>
            </dd>
          </div>
        ))}
        {(
          [
            ["Rationale", draft.rationale],
            ["Potential benefits", draft.benefits],
            ["Risks", draft.risks],
            ["Assumptions", draft.assumptions],
            ["Recommended next action", draft.nextAction],
          ] as const
        ).map(([label, text]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>
              <span className="preserve-text">{text}</span>
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
function AcceptAssessment({
  row,
  onDone,
}: {
  row: AssessmentProposal;
  onDone: () => void;
}) {
  const resource = useResource<IdeaDetail>(
      "/api/ideas/" + row.snapshot.command.ideaId,
    ),
    [reason, setReason] = useState(""),
    [apply, setApply] = useState(false),
    [replace, setReplace] = useState(false),
    [override, setOverride] = useState("");
  if (resource.error)
    return <Failure error={resource.error} retry={resource.refresh} />;
  if (!resource.data) return <Loading />;
  const idea = resource.data.idea,
    stale =
      idea.revision !== row.snapshot.command.inputRevision ||
      !!idea.canonicalIdeaId;
  return (
    <section className="panel prose-panel">
      <h2>Accept this assessment</h2>
      <p>
        Current active score: {idea.priorityScore ?? "Unrated"} ·{" "}
        {idea.scoreAuthority ?? "No selected evaluation"}
      </p>
      {stale ? (
        <p role="alert">
          The idea changed since this proposal. Reassess the current idea before
          acceptance. You can still reject this proposal while preserving it.
        </p>
      ) : (
        <ReviewedAction
          base="/api/assessment-proposals/decision"
          reviewPath={reviewPath}
          input={{
            decision: "Approve",
            proposalId: row.id,
            proposalRevision: row.revision,
            reason,
            applyToIdea: apply,
            replaceManualScore: replace,
            overrideReason: override,
          }}
          label="Review assessment acceptance"
          approvalLabel="Approve accepting the assessment"
          onDone={onDone}
        >
          <label>
            Assessment acceptance reason
            <textarea
              required
              rows={3}
              maxLength={2000}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>
          <label className="turn-select">
            <input
              type="checkbox"
              checked={apply}
              onChange={(e) => setApply(e.target.checked)}
            />
            Use this assessment as the active score
          </label>
          <p>
            Acceptance appends manually approved history. The active score
            changes only when selected here and included in the final approval.
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
                Assessment manual override reason
                <textarea
                  required
                  maxLength={2000}
                  rows={3}
                  value={override}
                  onChange={(e) => setOverride(e.target.value)}
                />
              </label>
            </>
          )}
        </ReviewedAction>
      )}
    </section>
  );
}
export function AssessmentReview({ id }: { id: string }) {
  const resource = useResource<AssessmentProposal>(
      "/api/assessment-proposals/" + id,
    ),
    [reason, setReason] = useState("");
  const row = resource.data;
  function download() {
    if (!row) return;
    const file = {
      format: "idea-lab-evaluation",
      version: 1,
      ideaId: row.snapshot.command.ideaId,
      inputRevision: row.snapshot.command.inputRevision,
      draft: row.snapshot.command.draft,
    };
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(file, null, 2)], { type: "application/json" }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "idea-lab-proposed-assessment.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">EVIDENCE, THEN A DECISION</div>
          <h1>
            Review the assessment<span>.</span>
          </h1>
          <p>
            Pending assessments do not change evaluation history or active
            scores.
          </p>
        </div>
      </div>
      <Link className="text-link" href="/review">
        Back to review center
      </Link>
      {resource.error ? (
        <Failure error={resource.error} retry={resource.refresh} />
      ) : !row ? (
        <Loading />
      ) : (
        <>
          <section className="panel prose-panel">
            <h2>
              {row.snapshot.input.title} · {row.status}
            </h2>
            <p className="preserve-text">{row.snapshot.input.summary}</p>
            {row.snapshot.command.ai && (
              <p className="preserve-text">
                AI origin: {row.snapshot.command.ai.resolvedModel} · deployment{" "}
                {row.snapshot.command.ai.deployment} · prompt{" "}
                {row.snapshot.command.ai.promptVersion}. Selected evidence and
                request provenance remain preserved in this proposal.
              </p>
            )}
            <p className="subtle-note">
              Assessed idea revision: {row.snapshot.command.inputRevision}
            </p>
            <p className="preserve-text">
              Queue note: {row.snapshot.command.note}
            </p>
            <Link
              className="text-link"
              href={"/ideas/" + row.snapshot.command.ideaId}
            >
              Open idea and history
            </Link>
            <button className="site-secondary mt-button" onClick={download}>
              Download proposed assessment
            </button>
            <p className="subtle-note">
              To revise it, load this private draft in the idea’s evaluation
              workbench. The original proposal remains preserved.
            </p>
          </section>
          <AssessmentEvidence draft={row.snapshot.command.draft} />
          {row.status !== "Pending" ? (
            <section className="panel prose-panel" role="status">
              <h2>{row.status} assessment</h2>
              <p className="preserve-text">{row.decision?.reason}</p>
              <p>
                The original proposal, evidence and rubric remain preserved.
              </p>
              {row.decision?.evaluationId && (
                <Link
                  className="site-primary"
                  href={"/ideas/" + row.snapshot.command.ideaId}
                >
                  Open accepted evaluation history
                </Link>
              )}
            </section>
          ) : (
            <>
              <AcceptAssessment
                key={row.revision}
                row={row}
                onDone={resource.refresh}
              />
              <section className="panel prose-panel">
                <h2>Reject this assessment</h2>
                <p>
                  Record the rejection while preserving the evidence. No
                  evaluation or active score is written.
                </p>
                <ReviewedAction
                  base="/api/assessment-proposals/decision"
                  reviewPath={reviewPath}
                  input={{
                    decision: "Reject",
                    proposalId: row.id,
                    proposalRevision: row.revision,
                    reason,
                  }}
                  label="Review assessment rejection"
                  approvalLabel="Approve rejecting the assessment"
                  onDone={resource.refresh}
                >
                  <label>
                    Assessment rejection reason
                    <textarea
                      required
                      rows={3}
                      maxLength={2000}
                      value={reason}
                      onChange={(e) => setReason(e.target.value)}
                    />
                  </label>
                </ReviewedAction>
              </section>
            </>
          )}
        </>
      )}
    </div>
  );
}
