"use client";
import Link from "@/components/navigation-link";
import { ExtractionOrigin } from "@/components/intelligence/extraction";
import { useState } from "react";
import { useResource } from "@/components/ideas/use-resource";
import { IdeaEditor } from "@/components/ideas/editor";
import { Failure, Loading } from "@/components/ideas/states";
import type { EditableIdea } from "@/lib/ideas/domain";
import type { ImportSource } from "@/lib/imports/provenance";
import type { AIExtractionResult } from "@/lib/intelligence/extraction-model";
import type { ExtractionProposal } from "@/lib/proposals/model";
import { ReviewedAction } from "./action";
export function SaveProposal({
  data,
  source,
  ai,
  onQueued,
}: {
  data: EditableIdea;
  source: ImportSource;
  ai?: AIExtractionResult;
  onQueued: (id: string) => void;
}) {
  const [note, setNote] = useState(""),
    [reconsider, setReconsider] = useState(false),
    [why, setWhy] = useState(""),
    [override, setOverride] = useState("");
  return (
    <section className="panel prose-panel">
      <h2>Keep this proposal for later review</h2>
      <p>
        This copies only the displayed draft and selected evidence into Notion
        Review Queue. Accepting it as an idea or recording a rejection is a
        separate action.
      </p>
      <ReviewedAction
        base="/api/proposals/store"
        input={{
          data,
          source,
          note,
          reconsider,
          reconsiderReason: why,
          ...(ai ? { ai, aiOverrideReason: override } : {}),
        }}
        label="Review proposal storage"
        approvalLabel="Approve saving the pending proposal"
        onDone={onQueued}
      >
        {ai && ai.classification !== "Idea" && (
          <label>
            AI classification override reason
            <textarea
              required
              rows={3}
              maxLength={2000}
              value={override}
              onChange={(e) => setOverride(e.target.value)}
            />
          </label>
        )}
        <label>
          Queue note
          <textarea
            rows={2}
            maxLength={2000}
            required
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
          Explicitly reconsider a prior rejection of this source revision
        </label>
        {reconsider && (
          <label>
            Reconsideration reason
            <textarea
              rows={2}
              maxLength={2000}
              required
              value={why}
              onChange={(e) => setWhy(e.target.value)}
            />
          </label>
        )}
      </ReviewedAction>
    </section>
  );
}
export function ProposalReview({ id }: { id: string }) {
  const resource = useResource<ExtractionProposal>("/api/proposals/" + id),
    [reason, setReason] = useState("");
  const row = resource.data;
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">
            SELECTED EVIDENCE, A DELIBERATE DECISION
          </div>
          <h1>
            Review the proposal<span>.</span>
          </h1>
          <p>
            A saved proposal becomes an idea only after explicit acceptance.
          </p>
        </div>
      </div>
      <Link className="text-link" href="/review">
        Back to review center
      </Link>
      {row?.snapshot.command.ai && (
        <ExtractionOrigin
          result={row.snapshot.command.ai}
          overrideReason={row.snapshot.command.aiOverrideReason}
        />
      )}
      {resource.error ? (
        <Failure error={resource.error} retry={resource.refresh} />
      ) : !row ? (
        <Loading />
      ) : row.status !== "Pending" ? (
        <section className="panel prose-panel" role="status">
          <h2>
            {row.status}: {row.snapshot.command.data.title}
          </h2>
          <p className="preserve-text">{row.decision?.reason}</p>
          <p>The original proposal and selected evidence remain preserved.</p>
          <p className="preserve-text">
            {row.snapshot.command.source.evidence}
          </p>
          {row.canonicalIdeaId && (
            <Link
              className="site-primary"
              href={"/ideas/" + row.canonicalIdeaId}
            >
              Open accepted idea
            </Link>
          )}
          <Link className="text-link" href="/sources">
            Return to selected imports
          </Link>
        </section>
      ) : (
        <>
          <IdeaEditor
            key={row.revision}
            initialDraft={row.snapshot.command.data}
            source={row.snapshot.command.source}
            proposalContext={{ id: row.id, revision: row.revision }}
            onSaved={resource.refresh}
          />
          <section className="panel prose-panel">
            <h2>Reject this saved proposal</h2>
            <p>
              Preserve its evidence and record why this selected source revision
              should not become an idea.
            </p>
            <ReviewedAction
              base="/api/proposals/decision"
              input={{
                decision: "Reject",
                proposalId: row.id,
                proposalRevision: row.revision,
                reason,
              }}
              label="Review proposal rejection"
              approvalLabel="Approve recording the rejection"
              onDone={resource.refresh}
            >
              <label>
                Rejection reason
                <textarea
                  rows={3}
                  maxLength={2000}
                  required
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
            </ReviewedAction>
          </section>
        </>
      )}
    </div>
  );
}
