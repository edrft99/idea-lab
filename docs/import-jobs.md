# Recoverable selected imports

Issue: #17. This checkpoint adds durable owner-scoped import progress to the existing selected-file/Notion workflow. The job is advanced by explicit owner actions, one reviewed item at a time. It is not an unattended scheduler or an automatic model-processing queue.

## Privacy and consent

Original exports and draft text remain in browser memory or the owner's explicitly downloaded private review file. Starting tracking sends only item UUIDs, stable source keys and source revision hashes. D1 retains job/owner hashes, attempt and lease state, operation/result IDs and a captured idea revision; it stores no import evidence, titles, model output or whole export. Requesting an idea/recovery review sends that one selected command to server memory. Only an explicitly approved save persists its selected evidence and fields in canonical Notion records.

Tracking starts only after reviewing the chosen draft list and checking the displayed metadata-retention consent. No item is saved or sent to a model when tracking starts. AI extraction keeps its existing separate selected-content/destination/policy consent and saved-proposal workflow; AI-backed drafts cannot use direct import capture to bypass that review.

## Durable checkpoints and private progress

The additive migration 0005 creates idea_lab_import_jobs and idea_lab_import_job_items in the existing operational DB. Job creation uses an owner/request-key uniqueness constraint and is idempotent for the exact manifest. A batch contains at most 100 distinct item/source identities, with at most 20 active unfinished jobs per owner. The server checks source identity/revision again for every review and save.

Version 3 private progress files contain only the selected proposals plus a job UUID. They include no approval tokens or leases. Versions 1 and 2 remain readable. A file's saved flags and canonical IDs cannot establish completion: restored drafts are marked saved only when the server's completed item has the same source key, source revision and normalized reviewed-command hash. Parent state also checks the exact current draft snapshot against asynchronous proof results.

The owner can reopen a recent job without draft text to inspect progress. To edit or finish an item, restore the matching private review file. Download it before closing the page; this design intentionally does not retain the draft payload remotely. Recent Saves links import operations back to /sources?job=<job UUID>.

## Approval, leases and attempts

Each item uses the shared IdeaService, canonical Notion adapter and source-identity lock. Preparing a review makes no Notion write. The receipt is actor/action/exact-payload/expiry bound and becomes import-create, which ordinary capture/MCP commit routes cannot execute. Job commits additionally require the current item/operation binding and an active, unexpired job.

The worker claims one 120-second fenced item lease and has at most three total attempts, including explicit recoveries. Before each actual Notion mutation, the adapter rechecks lease ownership, job status and expiry. Provider retries are never automatic. Rate-limit retry-after hints and bounded backoff must elapse before another reviewed attempt. Exhausted items require inspection; attempt limits do not reset on pause/resume.

Pause/cancel invalidate unused reviews and block new writes. Already-dispatched requests may complete. Resuming does not restore an old approval; a fresh exact review is required. No cancellation deletes a canonical record or blindly unlocks an ambiguous save. A stale worker cannot update a newer worker's checkpoints, downgrade its operation status or release its retained source lock.

## Recovery decisions

- A worker that stopped before consuming its pending approval returns to fresh review after its lease expires.
- A consumed operation proven stopped before any idea dispatch can resume the exact idea/source only after a new short-lived approval. The retained source lock and a fresh fenced lease still apply.
- An idea write whose response was lost is discovered by its canonical operation marker. Once the exact original idea and revision are verified, recovery can attach only the missing selected source, with fresh owner approval. It never recreates that idea.
- Explicitly rejected source writes can be reviewed again after the retry delay. Source dispatch is recorded immediately before the provider mutation, after schema/preflight reads.
- A dispatched idea or source with no positively verified result is ambiguous. Absence from a query is not proof of non-creation. Status checks do not replay it; the UI requires further checks or operator inspection.
- A positively verified idea plus source with the exact operation, revision and relation completes the checkpoint without another mutation.
- External idea/source changes, a conflicting operation, changed restored payload, missing locks, wrong owner, expired approval or stopped/expired job block recovery.

Immutable source provenance and canonical Notion identity remain authoritative. Scores and evaluation history are not modified by import recovery.

## Retention and scheduling

Jobs stop accepting new writes after 30 days. Status inspection remains available. List/create access opportunistically removes expired metadata, in bounded batches, only if no item/operation is running or uncertain. Unresolved saves retain their metadata for reconciliation. There is no scheduled cleanup task, automatic unlock or unattended processing claim. Review files remain under the owner's control and are not erased remotely.

## Verification

The local migration is applied. All 488 tests and TypeScript pass; the production build passes. Automated tests cover ownership/origin/JSON guards, metadata-only tracking without a Notion credential, source/manifest/payload substitution, native-route bypass refusal, concurrent workers, duplicate creation, exact approval/replay, cancellation, stale-worker fencing, fixed attempt budgets, retry timing, pre-dispatch crashes, lost responses, partial-source recovery, stale canonical edits, private progress v3 and retention of unresolved outcomes. Full API tests use the real Notion adapter against a synthetic provider, including a source rejection and a lost idea response.

Isolated browser QA verifies zero POSTs during file preview/staging, unchecked tracking consent, pause/resume disabling saves, exact review, an interrupted save, separate source recovery, one fixture idea plus one fixture source, private progress download, clear/restore and proof-bound completion. Mobile recovery has no horizontal overflow. Every real Notion/model API is blocked by the QA proxy; no real records or model calls were used. Screenshots and request-count evidence remain ignored local work artifacts.

Hosted rollout must apply migration 0005 before enabling this Worker version. Preserve the existing owner-private audience, native ChatGPT endpoint and Claude relay settings. Real owner-chosen imported content and final canonical provenance remain a separate live verification gate; do not claim that a synthetic import is a real personal-history import.
