# Roundtable UI and first GPT reviewer

The Roundtable navigation item opens /roundtable, where the owner can select a canonical idea. Idea detail pages link directly to /ideas/:id/roundtable. The manual evaluation workbench remains available.

The interface provides four selectable seats: GPT, Claude, Grok and GitHub Copilot. GPT is the first implemented independent reviewer. The remaining seats say Coming next and do not dispatch requests. Cross-review, final panel ranking, background runs and Notion report storage are future phases, described in evaluation-roundtable.md.

## First assessment

No idea excerpts are selected by default. The owner selects and edits/redacts excerpts, defines a measurable success outcome/time horizon, and supplies available resources and constraints. Prepare reads the canonical revision and returns an expiring exact-content review; it does not call a model. Approve & send to GPT dispatches one bounded Responses request.

The request includes only selected excerpts, success criteria, constraints, assessment instructions and the fixed viability-v1 rubric. It excludes idea identifiers/revisions, sources, attachments, current scores and evaluation history. Responses use structured output, no tools, no browsing, store=false, a deadline, bounded response bytes and no automatic retry. Runtime secrets and known sensitive patterns are redacted. Provider retention remains subject to the configured service policy.

The report includes feasibility, success and value-offered ratings (0–100 or unknown), per-dimension evidence, confidence, strengths, risks, assumptions, expansions and experiments with measurable success signals. Application code computes the equally weighted mean only when all three scores are known. This is GPT's provisional assessment, not panel consensus or a calibrated success probability.

Results stay in browser memory until downloaded. A private JSON download can be loaded for the same idea revision. Imported results are explicitly marked as having unverified provenance and cannot change a saved score. The original assessed brief is inspectable even if the editable form has since changed. There is no automatic Notion save or active-score projection in this first phase.

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

Approvals bind owner, normalized selected content, canonical revision, model/provider configuration, credential digest, prompt version and rubric. They expire after five minutes and are single use. Preparation and dispatch reject stale or superseded ideas. Identity, origin, body-size and strict payload checks precede provider access.

The ledger retains hashes and request status, not the idea brief or generated report. A completed receipt cannot dispatch again. An ambiguous response records uncertain status; read-only status checks never contact GPT. Ordinary idea edits and the shared AI budget are unlocked after the model request ends because generation cannot mutate Notion. A replacement model request requires a fresh content review and may incur another charge. A process that disappears before finishing its running operation still requires operator reconciliation; there is no unattended recovery worker.

Recent saves in Settings identifies GPT roundtable requests and checks status. It does not interpret a result digest as a Notion page ID. If the browser loses a completed result before downloading it, the ledger cannot recover the text.

## Verification

Repository tests use synthetic Notion records, SQLite and model responses. Browser QA uses a local synthetic owner and intercepted API responses, covering desktop/mobile and dark appearance, seat selection, empty selection, exact review before dispatch, one approved dispatch, reports, disconnected GPT and interrupted-request status/fresh-review behavior. No real model request, provider charge or Notion mutation is needed for these checks. Live GPT compatibility remains unverified until protected model credentials are configured and an owner-approved synthetic request succeeds.

API protocol reference: https://developers.openai.com/api/docs/guides/structured-outputs
