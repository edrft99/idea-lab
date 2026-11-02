# Roundtable UI and first GPT reviewer

The Roundtable navigation item opens /roundtable, where the owner can select a canonical idea. Idea detail pages link directly to /ideas/:id/roundtable. The manual evaluation workbench remains available.

The interface provides four selectable seats: GPT, Claude, Grok and GitHub Copilot. GPT is the first implemented independent reviewer. The remaining seats say Coming next and do not dispatch requests. Cross-review, final panel ranking and background runs are future phases, described in evaluation-roundtable.md.

## First assessment

No idea excerpts are selected by default. The owner selects and edits/redacts excerpts, defines a measurable success outcome/time horizon, and supplies available resources and constraints. Prepare reads the canonical revision, checks Notion storage readiness and returns an expiring review of the selected content and automatic storage scope; it does not call a model or write a report. Approve & send to GPT dispatches one bounded Responses request and authorises automatic storage of its completed assessment.

The request includes only selected excerpts, success criteria, constraints, assessment instructions and the fixed viability-v1 rubric. It excludes idea identifiers/revisions, sources, attachments, current scores and evaluation history. Responses use structured output, no tools, no browsing, store=false, a deadline, bounded response bytes and no automatic retry. Runtime secrets and known sensitive patterns are redacted. Provider retention remains subject to the configured service policy.

The report includes feasibility, success and value-offered ratings (0–100 or unknown), per-dimension evidence, confidence, strengths, risks, assumptions, expansions and experiments with measurable success signals. Application code computes the equally weighted mean only when all three scores are known. This is GPT's provisional assessment, not panel consensus or a calibrated success probability.

Completed assessments are automatically appended to Notion before the generation endpoint returns. There is no separate Save assessment button or save confirmation. The full report, selected brief, scores and provenance are stored as history, without replacing the idea’s active score. The UI shows Saved to Notion, restores saved score badges on reopening the idea, and offers a saved-history selector. Older revisions are explicitly historical. Loading a report for the current idea revision restores its approved brief for another request.

A Notion failure does not discard a successful GPT result or run GPT again. The response retains the assessment with a distinct failed/uncertain storage state. Definitive failures offer Retry automatic save; ambiguous writes offer a read-only Check save status. Download remains available as a fallback. Imported original results also save automatically when their original run proof is valid.


## Protected GPT configuration

Direct OpenAI Responses:

- IDEA_LAB_GPT_PROVIDER=openai-responses
- IDEA_LAB_GPT_MODEL: explicitly chosen account-available model supporting Responses structured outputs
- IDEA_LAB_GPT_API_KEY: model-service API credential
- IDEA_LAB_GPT_RETENTION_NOTICE: actual service retention/monitoring policy
- IDEA_LAB_GPT_MAX_OUTPUT_TOKENS: 2000–8000; default 4096
- IDEA_LAB_GPT_TIMEOUT_MS: 1000–60000; default 45000

Direct requests use the fixed https://api.openai.com/v1/responses endpoint and Bearer authentication. Custom endpoints and redirects are refused. No model or credential is silently selected.

Alternatively set IDEA_LAB_GPT_PROVIDER=azure-openai-responses and configure the existing IDEA_LAB_AI_PROVIDER/ENDPOINT/DEPLOYMENT/API_KEY/RETENTION_NOTICE settings. This uses the existing checked Azure transport and configured limits. The legacy single-model evaluation and extraction adapters remain supported.

Both routes share the existing IDEA_LAB_AI_REQUESTS_PER_HOUR budget with AI assessments, extraction and semantic requests. Protected settings are server-only; the browser never accepts or receives API keys. Missing or invalid configuration displays Connection needed and disables dispatch. Settings includes the connection state and setup instructions. The existing Claude-to-Idea-Lab connection does not enable a Claude reviewer.

## Approval and recovery

The initial request approval binds owner, selected content, canonical revision, model/provider configuration, credential digest, prompt/rubric versions and the generate-and-save-report-v1 scope. It authorises storing the generated report, not endorsement of its findings or changing active scores. Older generation-only receipts cannot silently acquire the new storage scope. They expire after five minutes and are single use. Preparation and dispatch reject stale or superseded ideas. Identity, origin, body-size and strict payload checks precede provider access.

The ledger retains hashes and request status, not the idea brief or generated report. A completed receipt never dispatches GPT again; it returns the existing Notion report when available. An ambiguous response records uncertain status; read-only status checks never contact GPT. Ordinary idea edits and the shared AI budget are unlocked after the model request ends because generation cannot mutate Notion. A replacement model request requires a fresh content review and may incur another charge. Storage retries only use the already completed, owner-bound GPT result and never dispatch the provider. A process that disappears before finishing its running operation still requires operator reconciliation; there is no unattended recovery worker.

Recent saves in Settings identifies GPT roundtable requests and checks status. It does not interpret a result digest as a Notion page ID. If the browser loses an unsaved completed result before downloading it, the ledger cannot recover the text. A report explicitly saved to Notion can be reloaded without another provider request. Save approvals bind the exact result and source run to the owner and idea revision; modified or fabricated AI provenance is rejected. Saves are idempotent per GPT run, and ambiguous Notion writes can be reconciled without replay.

## Verification

Repository tests use synthetic Notion records, SQLite and model responses. Browser QA uses a local synthetic owner and intercepted API responses, covering desktop/mobile and dark appearance, seat selection, empty selection, exact review before dispatch, one approved dispatch, reports, disconnected GPT and interrupted-request status/fresh-review behavior. No real model request, provider charge or Notion mutation is needed for these checks. Live GPT compatibility remains unverified until protected model credentials are configured and an owner-approved synthetic request succeeds.

API protocol reference: https://developers.openai.com/api/docs/guides/structured-outputs


## Reviewer scorecards

Each seat uses its vendor mark with three visible score badges: F (feasibility), S (success) and V (value offered). Missing assessments and unknown ratings show a dash. Only actual generated or loaded GPT ratings populate the first implemented seat; other providers remain Coming next.

Select a reviewer to inspect its own scores and evidence. The detail panel groups its report into Overview, Risks, Expand and Test next. Each score expands to show its evidence. Selecting an unconnected reviewer hides GPT’s report and shows the selected provider’s empty scores. The idea brief collapses after a result and can be reopened to prepare another request. Reading score evidence, switching report sections and selecting a seat make no provider calls.

Desktop uses a circular table arrangement and a scrollable selected-reviewer panel; mobile uses a four-seat grid and a full-height panel, with selection scrolling the panel into view. Vendor marks are bundled locally with LobeHub’s MIT licence and source attribution in public/vendors/.


## Automatic report verification

The existing Notion review schema holds a roundtable-report-v1 snapshot with the full result, owner hash, operation, timestamp, result digest and storageMode=automatic. Older reviewed snapshots remain readable. The server verifies the original completed GPT-run digest before storage or returning history. Machine-generated findings remain unapproved; the record is a saved report, not a new active score or a change to the idea.

The generation service checks storage readiness before preparing a paid request, then stores the validated output on the server before returning. Internal storage receipts bind the exact completed result to the owner; there is no second user approval. Duplicate saves return the same report. An idea change during generation preserves the completed report against its original revision as historical evidence, without projecting it onto the changed idea. A deleted/unavailable idea cannot receive a new report.

Interrupted Notion writes retain their storage lock until a read-only check finds and verifies the operation-marked record. Loading history also reconciles a confirmed report’s storage operation and releases its lock, so reopening a report cannot leave ordinary idea edits blocked. Request-status recovery can restore an already saved report after a lost generation response. Settings → Recent saves also supports automatic storage operations.

No migration, dependency or new runtime credential is required. Notion outages are shown as save failures rather than success; a result that was never stored and whose browser copy is lost cannot be recovered from a digest. A runtime disappearing before its operation is finished still requires reconciliation if no valid Notion record is found. No blind model or ambiguous write replay is performed.
