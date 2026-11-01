# Consented AI assessment requests

Idea Lab now has a disabled-by-default Azure OpenAI Responses adapter for one canonical idea at a time. The provider interface is replaceable. No model, endpoint, deployment, key or policy is silently selected, and no service is provisioned.

Open the idea's manual evaluation workbench, then choose Request a selected-content AI assessment. No fields are selected by default. Select and edit/redact title, summary, problem, solution, audience, expected value or context excerpts. Each excerpt is bounded to 3,000 characters and the selected object to 12 KB. Sources, conversations, URLs, current scores, evaluation history and canonical IDs/revisions are not included in the provider input. The request contains selected excerpts plus rubric and weights; the server retains the input revision mapping.

Review the exact redacted excerpts, destination/deployment, rubric/weights, output-token/request limits, retention notice and no-write scope. This step makes no model call. A separate explicit transmission approval sends one request and may incur provider charges. Consent binds owner, normalized payload, idea revision and provider configuration/policy, including credential rotation. Stale ideas, expired receipts, substitution and concurrent dispatch are rejected.

## Protected configuration

These are server-only settings, separate from NOTION_TOKEN:

- IDEA_LAB_AI_PROVIDER=azure-openai-responses
- IDEA_LAB_AI_ENDPOINT: the chosen resource's HTTPS /openai/v1/ endpoint.
- IDEA_LAB_AI_DEPLOYMENT: the explicitly chosen compatible deployment.
- IDEA_LAB_AI_API_KEY: that model service's credential.
- IDEA_LAB_AI_RETENTION_NOTICE: the actual service's retention/monitoring policy.
- IDEA_LAB_AI_MAX_OUTPUT_TOKENS: 2000–8000; default 4096.
- IDEA_LAB_AI_TIMEOUT_MS: 1000–60000; default 45000.
- IDEA_LAB_AI_REQUESTS_PER_HOUR: 1–100; default 5.

Keys belong in ignored local configuration or protected hosted runtime settings. They are not accepted in a browser field or uploaded with source archives. Missing/invalid configuration leaves AI disabled and manual evaluation available. No new Entra website login is introduced; Sites still handles website identity. Managed identity/Key Vault integration for model requests is not implemented.

The adapter permits only a validated Azure resource hostname under openai.azure.com or services.ai.azure.com, HTTPS, the fixed API path and no URL credentials, query, fragment or custom port. It uses the configured deployment, api-key header, strict JSON Schema, no tools, store=false, no streaming/background mode, a deadline and a 256 KB response-body limit. Redirects are refused and errors/refusals/incomplete/invalid output are not repaired or retried automatically. Server validation enforces every rating/evidence/range and rejects approval/tool fields regardless of model output. Known configured credentials and standard sensitive patterns are redacted from text; review remains necessary for other private information.

store=false is a request setting, not a promise of zero provider retention. The explicit configured policy is shown before transmission. Requests may be processed or charged even if the client loses the result.

## Results, authority and recovery

The result is an unapproved browser-local assessment with selected-input snapshot/hash, input revision, configured deployment, returned model identifier, prompt version, response identifier, times, usage when supplied and retention/output settings. Model output cannot choose weights, rubric, tool actions, consent or active-score authority. The application computes potential separately from effort/readiness.

The operation ledger stores request state and hashes only, including a digest of the normalized result; it stores no selected text or assessment. A consumed receipt never dispatches again. Recent Saves/status checks report request state without contacting the model. Browser results can be privately downloaded and loaded later. A lost result is not reconstructed from the ledger or fetched from provider storage. A new request needs fresh transmission review. A process lost while still running requires operator reconciliation; locks are not automatically cleared.

An hourly per-owner attempt budget is checked under a shared owner lock, with output-token and timeout caps. This is a request/output budget, not a monetary billing guarantee. Failed/stale attempts can consume the configured attempt budget; there is no automatic retry.

Saving a generated result to Notion requires a separate proposal-storage review. The server verifies its actor-bound completed-run digest and rejects forged/changed AI provenance or draft substitutions. A downloaded result therefore requires its original request ledger for proof before first storage. The original result can be retained; edits can be composed as a new manual assessment instead of falsely claiming unchanged AI output.

Notion stores the approved Pending proposal and full AI provenance. A further acceptance/rejection decision follows the assessment workflow. Acceptance appends history with AI origin/model/prompt provenance and human approval; history-only remains the default. Replacing a manual active score still requires explicit replacement choice/reason. Existing originals, evidence and history are preserved. The saved proposal remains authoritative for later review, rather than requiring a second content database.

The assessment-storage APIs have a bounded 96 KB JSON limit for result/provenance payloads; other forms retain their 24 KB default. Notion's existing page/rich-text payload preflight also applies. Oversized input is refused before persistence.

## Verification and open gates

287 tests across 26 files, TypeScript and the production Worker build pass. Synthetic transport/SQLite checks cover exact selected-only requests, no write during generation, consent/owner/origin/body guards, stale/expired/substituted configuration, hourly/concurrent budgets, redirects/provider errors, refusal/tools/invalid output, response bounds, timeout/no replay, result proof tampering and separate AI proposal acceptance with preserved manual scores/model/prompt/input provenance.

Isolated browser QA verified default-empty selection, local rejection of an empty request, summary-only selection, email redaction, inert script-like text, exact destination/content review, explicit dispatch, unapproved result and separate Pending proposal-storage preview. The 390px consent view has no horizontal overflow. One transmission prepare and one dispatch occurred; the storage preview was retried after correcting a fixture-only JSON-key-order comparison. No final proposal-storage commit was submitted. All APIs were synthetic and all real model/Notion mutations were refused. Result-file loading, request-loss recovery UI and live provider compatibility have automated or implementation coverage but were not browser-verified.

The real local runtime returns HTTP 200 enabled=false for AI configuration. No real model call, paid usage, new credential, Notion mutation, cloud provisioning, source push, Site version or deployment was performed. A compatible chosen deployment/key, provider eligibility/network/retention verification, live approved requests/writes and hosted identity/storage remain open. Extraction, embeddings, semantic classification/search, analyst, durable jobs and MCP remain further intelligence work. Managed source synchronization remains unresolved; this checkpoint is local.

## Official API references

The request's strict text.format JSON Schema and explicit refusal handling follow [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs). The fixed /openai/v1/responses path, api-key authentication and request options are based on [Microsoft's Azure OpenAI Responses REST reference](https://learn.microsoft.com/en-us/rest/api/microsoft-foundry/azureopenai/responses) and [Azure structured outputs](https://learn.microsoft.com/en-us/azure/ai-services/openai/how-to/structured-outputs). Deployment-specific compatibility still needs live verification; a mocked passing request does not prove account/model availability.
