# Explicit, recoverable idea merges

Open Review center → Review an explicit merge. Select the record to keep as survivor and one to five current canonical candidates. Enter a reason, acknowledge preservation, review the exact survivor/candidate IDs and versions, then approve the merge separately from any relationship classification.

## Result and preservation

The survivor keeps its description, lifecycle, current ratings, confidence and selected evaluation. It gains related links to every preserved candidate. Each candidate keeps its description, scores, sources and related links, becomes Archived, and points to the survivor using Canonical Idea. Nothing is deleted.

Every original Source and Evaluation remains on its original idea. The detail view follows canonical lineage to show preserved originals, combined source references and evaluation history with original-idea attribution. Nested earlier merges are included. No historical evaluation is reassigned or rewritten, and an original's score is never silently selected as the survivor's score. Default collection/dashboard reads omit superseded records; the Archived filter and direct detail links still expose them. Source filtering includes provenance inherited through lineage.

The application rejects edits and evaluations of superseded originals and directs future work to the survivor. The original detail view remains readable and links to the surviving record. An external Notion editor can still change these records; the app cannot prevent writes outside its boundary.

## Approval and journal

Approvals bind the owner, merge action, exact command, five-minute start expiry, every participant revision and digests of original states. Shared D1 locks cover the survivor, candidates and merge target. The ledger stores hashes/IDs/state, not idea content.

Before any idea PATCH, an immutable application-written Review Queue intent records the approved plan and digests, with full original description/current-assessment snapshots in child blocks. Its Approved status means intent was approved; it does not claim all steps finished. It is excluded from classification/rejection history.

Each idea step writes its operation marker with the intended properties. Recovery checks those markers, exact link/status/canonical fields and preserved content hashes. A completed save is terminal: a delayed error cannot reopen it.

## Interrupted saves

Use Recent Saves → Check status. This does not replay writes. If all intended record states are confirmed, the save becomes done. If a verified journal exists and every record is either unchanged since approval or confirmed as applied by this operation, an uncertain save offers Resume approved merge. Recovery conditionally claims one attempt, retains the original locks, skips applied steps, and rechecks all participants before every remaining step.

A changed description/score/source reference, unexpected revision/link/status/canonical state, tampered journal or missing lock stops recovery. Preserve that partial state for operator inspection. Missing/unverifiable journals and a process terminated while the ledger still says running are not automatically repaired or unlocked. These require operator reconciliation. There is no blind retry or automatic lock expiry.

Notion offers neither a transaction across pages nor compare-and-swap for this PATCH sequence. External edits can race between a final read and a write. This workflow preserves partial results and exposes uncertainty; it does not claim atomicity.

## Bounds and deployment status

Supported schema: Related Ideas and Canonical Idea are one-way self relations to the configured Ideas data source. The workflow refuses a different target or dual-property schema; it never changes schema automatically. Up to 100 related IDs per participant, five candidates, a 400 KB journal request bound and 100 records in a combined lineage are supported. Oversized/cyclic history fails explicitly rather than returning a silently incomplete view. Collection reads retain the existing 10,000-result bound.

163 automated tests across 18 files, TypeScript and the production Sites Worker build pass. Synthetic browser verification covered exact review/approval, one interrupted commit, status after navigation, explicit resume and the attributed survivor view. The mobile approval had no horizontal overflow at 390px. In-page navigation through the synthetic proxy failed to load a development module; full-page navigation was used, so that browser navigation path remains a verification limit.

Read-only local schema preflight passed and reached the expected absent synthetic-record guard. Live mutation permission, a real owner-approved merge, hosted identity/storage/secrets and production deployment remain unverified. This checkpoint is local; managed source synchronization remains unresolved. No real Notion records were created or modified by the agent.
