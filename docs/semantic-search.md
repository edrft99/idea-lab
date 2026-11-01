# Selected semantic index and search

Open /ideas/semantic from Explorer. Select 1–20 current canonical ideas and explicitly choose description fields; nothing is preselected. Review exact redacted, bounded excerpts, destination, deployment, dimensions, operator version label, retention and limits before approving one embedding request. Current valid vectors are skipped unless explicit regeneration is selected. Changed selection/configuration/revision, expired approval or another indexing request requires a fresh review.

A query has its own transmission receipt. Only the redacted query is sent to the model. Search applies current Notion category/status/source/effort/score filters, validates compatible cached vectors, recomputes selected-description hashes and excludes missing, superseded, changed, expired, invalid or incompatible entries. Every match uses current canonical content and a Notion link. Cosine similarity is not a probability or duplicate classification. Search never changes Notion records, sources, evaluations, manual scores, relationships or merge state.

## Disposable cache

D1 has a separate derived table, idea_lab_semantic_vectors (migration drizzle/0001_far_paibok.sql). It stores owner/profile hashes, idea ID, input hash/revision, selected-field names, returned model, dimensions, F32 little-endian base64 vector with integrity hash, operation ID and expiry. It stores no description text, source histories, query text/vector or scores. Embeddings remain sensitive derived data; keep the Site owner-private. Notion remains the sole authority.

Cache profiles bind endpoint, deployment, dimensions, the operator-pinned version label, input version semantic-fields-v1 and serialization version. Credentials bind approval context but key rotation alone does not invalidate compatible cached vectors. The returned provider model must also match during search. A deployment alias can change weights without changing returned metadata; the operator must pin compatible deployments, update the version label and explicitly rebuild after changes. Automatic weight-change detection is not claimed.

Vectors expire after 1 hour–7 days (default 7 days), with physical deletion on cache access. There is no background expiry job yet. Sparse selected-record indexing retains a 1,000-vector guard. Complete generations support up to three manifests and 3,000 retained vectors per owner, with at most 1,000 canonical ideas per manifest. The preview displays coverage limits. Clear the owner's derived vectors, snapshot manifests and active pointer through a separate exact-state receipt; clearing and status/cancellation work with model credentials removed. Rebuild requires new selected-content transmission consent. This local scan is not a managed vector service or an unbounded collection index.

Each field is redacted before clipping to 760 escaped JSON UTF-8 bytes (excluding its outer quotes), keeping the entire selected input below the 6,000-byte provider cap even for control characters. The full selected redacted field contributes to its hash so changes outside the transmitted excerpt still invalidate the cache. Only description fields are eligible; score changes do not cause semantic description invalidation.

## Configuration and operations

Use the server-only IDEA_LAB_EMBEDDING_* values in .env.example. Endpoint must be an allowed HTTPS Azure OpenAI v1 endpoint. Set deployment/key, exact returned dimensions, pinned version label and actual provider retention notice. Request dimensions only when the deployed model supports that parameter. This is a separate embedding deployment from the Responses assessment/extraction deployment. No credentials are required to run synthetic tests; missing configuration keeps real model requests disabled.

One request per reviewed batch/query; no automatic retry. Embeddings, assessments and extraction share the owner AI attempt budget and coordination lock. Responses are bounded, normalized and validated for complete indexed output, finite nonzero vectors and exact dimensions. Redirects are refused. Provider failures expose safe messages only.

Cancellation is limited to derived semantic operations. The cancellation endpoint fences later cache writes and terminal state updates. A provider may already have processed a dispatched request, so cancellation cannot guarantee avoiding cost. Valid partial rows may remain; check the cache and explicitly review remaining work. An interrupted complete index batch can be positively reconciled from its exact retained manifest without replaying a model call. Partial batches never trigger automatic paid replay. Query results exist only in browser memory; a lost result is not reconstructed or silently requested again. Recent Saves supports status and derived-operation cancellation without linking hash results as idea IDs.

## Verification and remaining gates

Synthetic SQLite/provider/API tests cover projection, field order, Unicode bounds, vector protocol, identity/origin/body consent, current Notion authority, model/profile mismatches, stale inputs, shared budget, owner capacity, replay/expiry, cancellation fences, partial persistence, lost completion and clearing without model configuration. Synthetic browser checks are interception-only and refuse all unmocked APIs. They cannot establish real model quality, deployment dimensions, provider billing/retention or hosted isolation/performance.

Migrations 0001 and 0002 are applied only to the local preview. Hosted migration/binding checks remain part of an authorized deployment. No live embedding request, paid model call, real Notion write, provisioning, source push or publication has been made. Relationship classification, grounded analyst, MCP and durable jobs remain separate backlog work.

Full-generation atomic rebuilding is now implemented locally with separately reviewed planning, batches and activation; see [semantic-snapshots.md](semantic-snapshots.md). Sparse caches and current Notion changes remain explicitly reported as partial coverage. Retrieval measurement on labeled examples, real quality and hosted verification remain open in IL-011.
