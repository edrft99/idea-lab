# Evaluation workbench and approved history

The private Site now has an offline manual scoring workbench at /evaluations. It can calculate and download/restore an assessment without a Notion token. Open a canonical idea and choose Evaluate to review an authoritative save after connection.

## Rubric and evidence

Five integer ratings from 1–5 use versioned configurable weights totaling 100%. Defaults: Impact 30, Alignment 25, Feasibility 20, Reusability 15, Timing 10. Potential = sum((rating - 1) * weight / 4), rounded to 0–100. All 1s map to 0; all 5s map to 100. Missing ratings or invalid weights show no score.

Each dimension requires evidence. The assessment also records rationale, benefits, risks, assumptions, effort, readiness, confidence and recommended next action. Effort/readiness are excluded from potential. Manual assessments have modelIdentifier=manual and no AI prompt version. No AI endpoint is called. A strict structured AI-output schema exists for later provider work; it cannot self-authorize an active score or invoke tools.

Local draft files are versioned and contain evidence/assessment plus optional idea ID and input revision, never approvals or completed status. Loading a linked draft for a different/older record fails; standalone drafts require fresh canonical review. Local work is held in memory and can be lost on navigation. Downloads must be kept private.

## Two explicit save choices

Every approved save appends a new immutable evaluation record. By default it keeps the active score and selected evaluation unchanged.

Selecting an active score additionally projects only ratings, potential, confidence, Latest Evaluation, Last Reviewed and approval/revision metadata. Idea description, status, sources, relationships, effort, readiness and next action remain unchanged. Those assessment recommendations remain in evaluation history.

Replacing a manually approved active score requires a separate choice and a reason. Exact evidence, weights/rubric, before/after score and scope are shown before a short-lived actor/payload/input-revision-bound approval is issued. Prepare performs reads only. Single-use claims share the idea lock with ordinary edits. Stale input and substituted payloads abort before history creation.

## Notion persistence and recovery

The application only creates evaluation pages; it never edits/deletes earlier evaluations. Properties retain ratings, rationale/evidence, model, rubric, input revision and weight snapshot. A structured immutable body snapshot retains all draft fields, operation/actor and override reason. A deterministic operation marker in the evaluation title enables reconciliation without adding a new schema field.

Appending history and projecting the active score are separate Notion requests. Notion offers no cross-page transaction or compare-and-swap. External edits can race with the final check. A partial or ambiguous result retains its lock; status checks read the operation-marked evaluation and, for active changes, the matching selected evaluation and revision marker. They never blindly replay a write. Recent Saves dispatches evaluation reconciliation correctly and links to the canonical idea rather than treating the evaluation ID as an idea.

A known read failure before any mutation is attempted releases the lock. Missing/ambiguous projection remains unresolved for operator review. Automatic repair of a known partial projection is still follow-up work.

## Verification

88 automated tests now cover the app. New coverage includes scoring boundaries/custom weights, required evidence, strict AI output/draft validation, manual protection, stale/tampered approvals, shared locks, partial projection and reload recovery. Complete mocked Notion flows assert one immutable history creation, optional restricted projection, metadata/body snapshots and no duplicate writes on replay. API tests verify identity, ownership, origin and request validation.

Browser checks verify zero POSTs from the offline workbench; 0/100 scoring endpoints and invalid-weight handling; private draft download/restore; manual-override confirmation; rejection of older linked drafts; exactly one review, commit and status check through an intercepted uncertain save; correct Recent Saves links; desktop/mobile layout and dark appearance. All provider records and screenshots are synthetic. No real Notion record was created or modified.

Live token-backed reads/writes, hosted identity/storage and production deployment remain pending. Duplicate review/merge execution and configured AI scoring are not implemented by this workbench.

Primary format reference: [Notion block objects](https://developers.notion.com/reference/block). The implementation preserves the existing configured data sources and property-ID mapping.

## Saved assessment review

The workbench now offers a separately reviewed Pending proposal save. See [evaluation-proposals.md](evaluation-proposals.md) for acceptance/rejection, manual score protection and explicit verified recovery. This adds manual proposal review; no AI provider is called.
