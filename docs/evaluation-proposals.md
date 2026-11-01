# Saved evaluation proposals

The canonical idea's evaluation workbench can now preserve a completed manual assessment as a Pending Notion Review Queue proposal after explicit storage review and approval. The proposal includes one idea snapshot/revision, all ratings and evidence, weights/rubric, rationale, benefits, risks, assumptions, effort, readiness, confidence, next action and queue note. Storage creates no Evaluation and changes no idea score.

Review center opens saved assessments separately from relationship and extraction reviews. Acceptance requires an explicit reason and exact approval. History-only is the default. Selecting the active score is optional and part of that exact approval; replacing a manually approved score also requires an explicit replacement choice and override reason. Acceptance appends immutable manual-approved Evaluation history, optionally projects only ratings/confidence/latest evaluation/approval metadata, and resolves the original review. Descriptions, sources, lifecycle, effort, readiness and next action are preserved.

Rejection records an authoritative reason and preserves the original input, assessment, note, evidence and page body. It creates no evaluation and changes no active score. A stale or unavailable idea cannot be accepted but its assessment can still be rejected.

Repeated pending/accepted assessments with the same idea, revision and assessment content redirect to existing review history. Rejected identical assessments require explicit reconsideration and a reason. Materially changed content or a new idea revision can receive another proposal; prior history is preserved. Direct evaluation save rechecks this review history under the shared idea lock, so an older draft cannot bypass the decision workflow.

To revise a saved assessment, download its private draft and load it in the canonical idea's evaluation workbench. Draft revision checks still apply. Acceptance consumes the stored draft; the client cannot inject replacement ratings, provenance, model metadata or approval fields into a decision.

## Write and recovery boundaries

Short-lived receipts bind actor, action, exact normalized payload, original review revision and immutable proposal snapshot. Storage locks both assessment identity and its idea; decisions lock the original review and idea. D1 contains only coordination state, hashes and identifiers. A last-result locator is re-read and validated against authoritative Notion records when query indexing lags.

An immutable decision intent precedes evaluation persistence. Recent Saves checks markers and full saved assessment fields, including per-dimension evidence, weights, rubric, input revision, actor and manual authority. Status checks never replay a write.

Explicit resume never recreates Evaluation history. It can finish the original queue resolution after history/score verification. If the evaluation is positively verified and an approved active-score projection has not happened, resume may apply it only while the idea still matches its approved revision and snapshot. An already confirmed score is not projected again. Changes, missing history/intent/locks, ambiguous records or a process lost in running state require operator reconciliation; no blind replay or automatic unlock.

Both extraction and assessment reconciliation now require the recorded decision and reason to match their exact approval, in addition to operation/intent/result identifiers. External changes to a resolved reason are not silently confirmed.

## Verification

252 tests across 24 files, TypeScript and the production Worker build pass. Tests use synthetic Notion transport and real SQLite coordination: storage/acceptance/rejection, default history-only behavior, optional projection/manual protection, stale input, reconsideration, delayed query indexing, exact approval guards, lost replies at each step, denied/lost projection, queue-only recovery, competing decisions, altered history/reasons and direct-save bypass protection. Owner/origin/strict-body guards and common recovery dispatch are covered.

The isolated browser verified manual replacement controls, refusal without replacement consent, exact approval, acceptance, stale-input blocking and preserved rejection. The 390px approval view had no horizontal overflow. Fixture counts: three prepares (one denied), two commits, final statuses Approved and Rejected, zero unmocked API requests. All responses and records were synthetic; no real Notion records were changed. Full-page navigation was used. Storage and recovery have automated coverage but were not browser-tested in this checkpoint.

A read-only request through the configured local runtime passed Review Queue schema preflight and reached the expected absent-record HTTP 404 NOT_FOUND guard. This is not live write verification. Actual owner-approved writes and hosted identity/storage/secrets remain pending. AI evaluation is not configured or called; this is the manual-proposal path. Durable jobs, general recovery/retention/export/index rebuild and managed source synchronization remain open. No new hosted Site version or deployment is claimed.
