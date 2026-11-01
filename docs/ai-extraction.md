# Selected AI extraction

The import workspace can now request AI extraction for one explicitly staged excerpt from ChatGPT, Claude Code, Codex or selected Notion content. File parsing, previews, local hints and staging make no model call. A separate transmission review shows the exact excerpt/role, destination/deployment, prompt version, retention notice, limits and no-write scope.

The model receives only the selected evidence and its user/assistant/document role. IDs, URLs, dates, other turns, idea collection and approval state are excluded. Source provenance is held by the application. Known configured credentials and common sensitive patterns are redacted before review; credential-bearing original URLs are withheld. Other sensitive content still requires human inspection.

The provider returns Idea, Routine or Uncertain, a reason, confidence and at most one candidate. Routine must have no candidate; Idea requires one. Prompts distinguish reusable concepts from ordinary questions/troubleshooting and ask for uncertainty on assistant-only suggestions, vague evidence or several ideas needing narrower selection. These are model instructions, not proof of classification quality. Unsupported output, source/lifecycle/approval injection and invalid categories/ranges are rejected. The application assigns initial lifecycle values; model output grants no permission to search, save, score or merge.

## Consent and configuration

Extraction uses the protected Azure model settings documented in [ai-assessments.md](ai-assessments.md). It remains disabled unless a compatible deployment, key and actual retention policy are configured. This is separate from NOTION_TOKEN; no new credentials or resources are created by the feature.

Extraction and assessment now share the same per-owner hourly attempt budget and owner dispatch lock. Source identity is also locked during extraction. Receipts bind actor, normalized selected evidence/provenance, expiry, provider/deployment/policy/credential configuration and extraction-v1 prompt version. Notion excerpts are verified at review and again under the source lock; stale/moved/unavailable content stops before dispatch. File excerpts can be extracted without any Notion connection. There is no automatic history upload or filesystem scan.

The two tasks share a bounded Responses transport: validated HTTPS Azure destination, no redirect following, tools, streaming/background mode or automatic retries; strict JSON, response-size and timeout limits, safe errors and text redaction. store=false is requested but does not promise zero provider retention or zero charge after a lost response. Local request/status records contain hashes and identifiers only. Status checks never replay the model request; a new request requires fresh transmission review.

## Human review and preserved history

The result remains local and is attached to its import draft. Extracted fields prefill an editable draft; if no candidate was extracted, the prior local draft is retained. Direct canonical capture is removed from an AI-backed draft's form. It must first pass the separate Pending proposal-storage review and then the canonical acceptance/rejection workflow.

Human edits are allowed while the original AI result remains unchanged. Storing a Routine or Uncertain classification as an idea proposal requires an explicit human override reason. The storage/decision reviews show the model classification, rationale and original suggestion separately from the reviewed fields. Rejection/reconsideration memory and source identity guards still apply.

Before first Notion storage, the server verifies the current owner's completed-run digest and exact matching source. Forged, altered or cross-owner AI results are refused. This is generation attestation, not a second content database. The downloaded result needs its original request ledger for attestation at first storage. Once saved, the authoritative Review Queue proposal preserves the AI result and human decision.

Acceptance creates no evaluation or score. The selected Source body uses snapshot version 2 for AI-backed captures and preserves the original evidence, model/deployment/prompt/input/request provenance, original classification/result and the proposal/intent identifiers plus human override reason. Existing non-AI source snapshots remain version 1 and are not rewritten. Canonical field edits do not overwrite the original AI result or source evidence.

## Private progress and limits

New import-review downloads use version 2 and preserve selected source, AI result and human-edited draft. Legacy version 1 files remain readable; unknown versions, duplicates and source-swapped AI progress are rejected. These files grant no write approval and contain no approval token. Restored canonical references and AI provenance are unverified hints until server checks.

A private extraction result can also be downloaded/loaded for the same source. Files remain private; there is no automatic browser persistence. The application rejects a progress download that would exceed the matching 10 MB restore limit, rather than producing an unreadable file.

There are still at most 100 staged proposals and 1–6000 characters per excerpt. The extraction consent and proposal-storage endpoints have a bounded 96 KB JSON limit; other forms retain their existing defaults. Notion page/rich-text preflight still applies. Splitting one turn into several canonical ideas, combining evidence across turns and durable server jobs remain follow-up work. An uncertain/multiple-idea excerpt should be narrowed manually; the model does not silently select a collection of ideas.

## Verification and remaining gates

317 tests across 28 files, TypeScript and the production Worker build pass. New checks cover Idea/Routine/Uncertain validation, source/lifecycle injection, no retry/redirect, redaction, file extraction without Notion, exact consent/expiry/owner guards, Notion revision rechecks, shared assessment/extraction budgets, concurrent locks, forged proof, v1/v2 progress compatibility, size limits, human edits/overrides and full approved Idea/Source capture with preserved AI history through a mocked provider and real SQLite coordination.

Isolated browser QA used a synthetic ChatGPT troubleshooting excerpt. It verified local parsing/selection/redaction/staging, exact excerpt-only transmission review, explicit dispatch, Routine classification with no candidate, retained/editable local draft, required override reason, absence of a direct capture button, and a separate Pending proposal-storage preview. A real downloaded synthetic progress file was inspected: version 2, one proposal, preserved Routine result and edited title, no approval token. The 390px review has no horizontal overflow. The synthetic session was cleared afterward.

Fixture counts: one extraction prepare, one dispatch, one storage preview, zero unmocked APIs and zero Notion mutations. No final proposal-storage/canonical commit was submitted in the browser; that path has automated provider/API coverage. Real classification quality, assistant/multi-idea behavior, Notion/Claude/Codex browser extraction and live provider compatibility are not claimed as verified. Initial browser navigation and download observation were unusually slow; subsequent interactions were verified in the existing tab.

The real local runtime returns HTTP 200 enabled=false for AI. No real model call, paid usage, new credential, personal source fixture, Notion mutation, provisioning, code push, Site version or deployment was performed. Live chosen-model requests/writes, semantic matching/search, durable imports, broader recovery/retention, analyst, MCP and hosted identity/storage remain open. Managed source synchronization remains unresolved. This checkpoint is preserved locally.

The HTTP/structured-output protocol is unchanged from the [official API references](ai-assessments.md#official-api-references) recorded for the assessment adapter; extraction shares that transport rather than adding another API variant.
