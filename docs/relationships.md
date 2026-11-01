# Relationship comparison and review decisions

The Site now supports side-by-side comparison of canonical ideas and local import drafts. It records manual relationship decisions while preserving idea descriptions, scores, sources and evaluation history.

## Canonical workflow

Open Review center → Compare two canonical ideas, or Compare and decide on a pending pair. Choose Duplicate, Refinement, Related or Distinct, explain the evidence, review the exact scope and explicitly approve the save. Pending suggestions also support Reject. Leaving the choice blank performs no write.

Classification records judgment only. The separate Link these ideas action now previews and adds a related link in both directions after explicit approval. Duplicate does not merge records; merge execution now uses a separate named-survivor approval in /review/merge.

Every decision appends an immutable Review Queue record with actor, reason, canonical input revisions, content fingerprints, operation marker and structured journal. Manual decisions leave AI Recommendation and Similarity Score empty rather than inventing model output. Resolving an existing pending review happens after the decision is appended. Its original reasoning, recommendation, input metadata, payload and originating Operation ID are preserved.

## Rejection memory and version checks

Pair identity is order-independent and UUIDs are normalized. Comparison content consists of title, summary, problem, solution, audience, expected value and context, normalized for Unicode/line endings/edge whitespace.

A completed decision for the same comparison content requires explicit reconsideration. Score and lifecycle changes do not erase its rejection memory. Changed comparison content reopens review with an explanation. Legacy records without content fingerprints use exact stored input revisions conservatively. Reversed candidate/match ordering still finds the same pair.

Canonical idea versions and the pending review revision are checked when preparing and executing. Superseded records require selecting their surviving canonical idea. An obsolete or unknown-version proposal can be rejected, but cannot silently classify newer content. Rejecting an obsolete proposal retains its older/unknown revisions and does not suppress suggestions for new content.

## Approval, coordination and recovery

Review approvals bind actor, exact payload, input versions, expiry and action. Shared coordination locks cover both canonical ideas, the pair identity and pending review. Ordinary edits and evaluations use the same idea locks. Partial acquisitions release only locks acquired by that attempt; a simultaneous replay cannot clear another attempt's locks.

Appending a decision and resolving a pending row are separate Notion requests. Ambiguous results retain locks. Reconciliation checks the operation-marked immutable decision and the original row's matching reviewer-decision marker before confirming completion. It never blindly replays a mutation. Recent Saves dispatches the correct workflow and links to a review rather than treating its ID as an idea.

Notion has no cross-page transaction or compare-and-swap. External writers can still race after the final check. Safe automatic repair of a known partial queue update remains follow-up work.

## Local import comparison

Select a staged proposal, then choose another draft. Compare their descriptions and a clearly labeled word-overlap hint. This is not embedding similarity or an AI duplicate verdict. It makes zero application API requests. An explicit local skip is retained in the selected-only review download. Imported markup remains inert text; no merge or canonical rejection is implied.

## Verification

163 tests pass across the application, including relationship evidence validation, material-content rejection memory, case normalization, multi-record lock concurrency, preserved proposal fields, stale inputs, uncertain writes and API authorization. Provider tests create only mocked Notion records and assert that comparison decisions do not patch either idea.

Isolated browser sessions verified reconsideration and final approval, one commit/status check through an uncertain response, correct Recent Saves links, obsolete-proposal restrictions, resolved-record read-only behavior, zero-request local draft comparison, retained skips, inert imported markup, desktop/mobile layout and dark appearance. Screenshots contain synthetic data only. No real Notion writes were performed.

The strict future AI classification contract permits Duplicate/Refinement/Related/Distinct/Uncertain and requires exact evidence quotes from both retrieved records. Unknown records, fabricated quotes and tool/merge fields are rejected. Configured model classification and embedding retrieval are not implemented by this comparison workflow.

## Explicit related links

Link these ideas requires a reason and a separate approval bound to both versions and original content/link digests. It journals approved intent in Notion before changing each Related Ideas property. Existing relations and all description/score/source/evaluation fields are preserved. Link journals are excluded from classification and rejection memory. The supported schema is a one-way self relation to Ideas; additions beyond 100 relations are rejected.

Recent Saves checks both exact operation markers and link sets. An interrupted save with a verified journal and unchanged inputs can be explicitly resumed; applied sides are skipped. A tampered journal, missing locks or external edits blocks recovery. Notion cannot provide atomic cross-page updates or compare-and-swap. A process lost while status remains running, absent journals and conflicts require operator inspection; no automatic lock expiry or replay is provided. Live writes still need an owner-approved record.

## Explicit merges

Review center now links to a separate named-survivor merge workflow. Classification never executes a merge. See [merges.md](merges.md) for preservation, canonical lineage, recovery, bounds and live verification gates.
