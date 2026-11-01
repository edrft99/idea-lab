# Saved extraction proposals

A local import draft can now be saved as a Pending Notion Review Queue record after a separate review and approval. Storage copies only its displayed fields, selected source evidence, provenance, revision and queue note. It creates no canonical Idea, Source or Evaluation.

Open the saved proposal from Review center. Acceptance shows the proposed fields and requires a reason and a new exact approval. The service reads the immutable selected source from the saved proposal, rechecks external Notion evidence when applicable, appends an immutable decision intent, creates an Idea and linked Source, positively verifies both, then resolves the original proposal. Rejection preserves the original proposal and evidence, records a reason and creates no canonical records. A stale/unavailable external source can still be rejected.

The same selected source revision cannot receive another pending proposal. Rejected revisions require explicit reconsideration and a reason; a changed revision may be separately proposed. The prior rejection remains preserved. Direct import capture redirects any source with saved extraction history to proposal review. A local checkpoint cannot bypass that history.

Receipts bind the owner, action, normalized payload, expiry, original proposal revision and source snapshot. Storage and decisions share source locks with direct capture; decisions also lock the proposal. Notion is authoritative. D1 contains hashes, identifiers and coordination state only; its last-result identifier is merely a locator, reread and validated against Notion when query indexing lags.

## Interrupted saves

Recent Saves checks operation markers without replaying writes. A confirmed lost storage reply can reconcile to its existing proposal. A decision is complete only after the canonical Idea/Source (acceptance) and original queue resolution are verified.

Explicit recovery may finish only the original queue update after the immutable intent and, for acceptance, the complete canonical capture are positively verified. It never repeats Idea or Source creation. A missing source, missing intent, changed canonical fields, changed queue revision, conflicting metadata or lost lock requires operator reconciliation. A process lost while the ledger still says running is not automatically unlocked or replayed.

The original proposal payload, note, evidence, originating operation and page body remain unchanged during resolution. The decision is appended as a separate intent and recorded in the original's decision metadata.

## Verification and limits

221 automated tests pass across 22 files, including a mocked Notion transport with real SQLite coordination. New checks exercise storage, acceptance, rejection, reconsideration, delayed query indexing, payload/actor/action/expiry/revision guards, lost replies, partial capture, competing decisions, external changes and direct-capture bypass prevention. Owner/origin/strict-body API guards and common recovery dispatch are covered.

An isolated browser fixture verified opening a Pending proposal, preparing acceptance, explicit approval, and the resolved view with preserved evidence and canonical link. All API requests were synthetic; no real Notion records were changed. The fixture used full-page navigation. Rejection/storage UI and responsive proposal layouts have not received browser verification in this checkpoint.

TypeScript and the production Worker build pass. The local runtime's read-only connection check returned HTTP 200 with verified reads; the configured hub self-import guard returned HTTP 409 before content reads. Live owner-approved writes, evaluation proposal review, durable import jobs and hosted identity/storage/secrets remain open. Managed source synchronization is unresolved; this checkpoint is local and is not deployed.
