# Atomic semantic snapshot rebuilds

Open Complete snapshot rebuilds on /ideas/semantic. Nothing is preselected. Explicitly include the whole current canonical collection and choose description fields. Planning reads current Notion ideas and reviews the exact membership and fields; approval stores only IDs, hashes and pinned model metadata. Planning does not call a model or change Notion.

Select up to 20 remaining records for each batch, review their exact redacted bounded descriptions and destination/policy, then separately approve one model request. Select next 20 remaining records is an explicit selection action, not an automatic job. Completed vectors remain in an inactive generation. A partial batch can be retained and positively inspected, but cannot become the active search snapshot. Valid rows are not automatically regenerated after interruption.

After every manifest record has a valid compatible vector, review activation separately. Activation rereads all current canonical membership and selected descriptions, checks every vector's integrity/profile/model/expiry and binds the previous active pointer including its operation marker. One guarded SQL statement changes the owner-scoped pointer; a competing pointer change, cancellation, expired/incomplete cache or stale selected content prevents activation. Planning/activation/discard make no model call. Empty canonical collections can be explicitly planned and activated without embeddings.

## Authority and consistency

Notion remains the sole authority. Snapshots contain no idea descriptions, sources, evaluations, scores or query vectors. Full-generation record revisions are stored as hashes. The manifest, selected input hashes, logical model profile and separate storage profile are validated on read. The storage profile isolates generations even when they use the same embedding deployment/version.

Search reads one active generation and still checks current Notion fields and lineage for every match. It does not silently fall back to a sparse or older index if the active manifest is expired, missing, incomplete or incompatible. Current filtered canonical records without vectors are reported separately, along with changed/missing/invalid/incompatible entries. Existing scores are preserved; score-only revisions do not invalidate selected description hashes. Sparse selected-record indexing remains available before a full snapshot governs search and cannot mutate an active snapshot.

Notion pagination and external writers are not transactional. A writer can change Notion after the final canonical check and before the local pointer switch. The SQL switch is atomic for the verified cache manifest; it cannot freeze Notion. Current-query hash/lineage checks exclude later changes and coverage reports show missing/new records. This is not a claim of a cross-service transaction or an instantly synchronized index.

## Storage and recovery

Migration drizzle/0002_steep_blob.sql adds immutable manifest metadata and an active-pointer table; existing vector rows are preserved. Local migration is applied. A snapshot contains at most 1,000 canonical ideas; larger collections are rejected before any model call rather than silently truncated. At most three manifests and 3,000 vectors per owner are retained across generations. Sparse indexing retains its earlier 1,000-vector guard. The UI exposes counts and lets the owner review discarding inactive snapshots while keeping active search intact.

Snapshot vectors share the manifest's original expiry (1 hour–7 days), so later batches cannot extend retention. Plan review shows the minimum batch count, shared hourly attempt budget and retention window; choose enough time to finish. There is no automatic batch loop, scheduler, paid retry or activation. HTTP request bounds, model limits, current Notion API quotas, Worker CPU/memory/subrequest limits and useful full-collection performance still require hosted/live measurement.

Complete cache clearing removes owned vectors, manifests and the pointer in a D1 transaction. Inactive-snapshot discard similarly removes only its owned vectors and manifest, and refuses the active snapshot. Both operations check the exact reviewed cache fingerprint under the owner lock; they work without model configuration. SQL failure rolls back the complete multi-table operation, per the [D1 batch transaction contract](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch). Each manifest is bounded below the [D1 row/string and query limits](https://developers.cloudflare.com/d1/platform/limits/).

Expired vectors/manifests are cleaned on semantic cache access. The active pointer's small operation marker can remain as an unavailable reference, preserving the no-fallback rule until replacement or explicit clearing. There is no background cleanup service yet.

Cancellation is limited to derived operations and fences later vector writes and terminal updates. A provider may already process a dispatched request; cost, verified partial vectors or a committed pointer switch can remain. Positive recovery verifies retained manifests, complete batch rows, activation operation markers or discarded-cache absence, without replaying model or Notion requests. Recent Saves exposes understandable snapshot action labels and cancellation/status. No canonical write, relationship or merge approval is implied.

## Verification and remaining work

Synthetic SQLite/provider/API tests cover complete and empty manifests, revision/payload/profile binding, owner/origin/body guards, model mismatch, stale membership/descriptions, score preservation, partial persistence, competing activations, cancellation before/after the pointer switch, lost completions, expiry/no fallback, transactional rollback and scoped clearing/discard. Isolated browser QA verified explicit planning, individual batches, disabled partial activation, separate atomic activation, search using the new snapshot, inactive discard, cancelled late results and mobile layout. No real model or Notion write was made.

Labeled retrieval evaluation, actual embedding quality/dimensions/retention/billing, hosted identity/storage/migration/transaction execution and performance remain open. SQL atomicity is tested on the real SQLite schema and follows the supported D1 contract; synthetic tests do not establish production hosting or semantic quality. No source push, publication, provisioning or paid model call follows from this checkpoint.
