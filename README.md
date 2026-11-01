# Idea Lab

Private Notion-backed workspace on the supported Sites Worker/Vinext runtime. Notion remains the authoritative store for ideas, sources, evaluations and reviews.

Implemented: dashboard, searchable/filterable Explorer, canonical detail/history, manual capture with source provenance, reviewed edits/status changes, connection diagnostics and recovery for uncertain saves. No automatic merges or deletes. Missing credentials produce an explicit unavailable state.

## Current production checkpoint

The owner-private Site and canonical UI capture are live. ChatGPT and Claude authentication/read access are verified; the owner reports capture through both clients. The Claude relay is separate and public only for its OAuth transport; see [Claude OAuth](docs/claude-oauth.md). Recoverable import jobs (#17) are deployed in production version 9; see [import jobs](docs/import-jobs.md). Real owner-chosen source import/provenance remains a separate verification gate. Historical feature-specific verification notes below do not imply all workflows have been exercised live.

## Setup

Copy .env.example to ignored .env.local for local development. Set NOTION_TOKEN to the internal integration secret and share the four databases with that integration. Configure all four data-source IDs and database URLs. The owner must match trusted Sites identity using IDEA_LAB_OWNER_USER_ID (preferred) or IDEA_LAB_OWNER_EMAIL. Keep the hosted audience owner-private.

Hosted secrets belong in Site runtime environment settings; local .env.local is not uploaded. Never paste credentials into browser fields or commit them. No Entra website login is needed.

Use Node.js 24. Run `npm run install:ci`, then `npm run dev` for local preview. Run `npm test`, `npm run typecheck` and `npm run build` for verification. No Codex installation or production credentials are required for these checks. See [deployment](docs/deployment.md) for the supported Sites publication workflow.

## Approval ledger

D1 binding DB contains an approval ledger (hashes, target/result IDs, state, expiry and locks) and a separate disposable semantic vector cache (vectors, IDs, hashes and model/version metadata). Those tables do not store idea descriptions or scores. Assistant capture additionally uses a five-minute owner-scoped selected-draft staging table; see [assistant-capture.md](docs/assistant-capture.md) for retention and approval details. Notion remains the only idea authority. Migrations drizzle/0000_robust_talisman.sql, drizzle/0001_far_paibok.sql and drizzle/0002_steep_blob.sql are applied locally. Assistant capture migration drizzle/0003_left_joystick.sql, Claude authorization migration 0004 and import job migration 0005 are also applied locally. Import jobs add operational checkpoints only; selected import text is not retained in those tables. Sites must provision/apply the declared migration when deployment is authorized; verify the binding before enabling writes.

Every mutation requires owner identity, same-origin JSON and a short-lived, actor/payload/revision-bound review receipt. Conditional claims prevent replay and concurrent local edits. Notion has no compare-and-swap: an external edit between final revision check and PATCH remains a race.

Ambiguous writes are not retried automatically. Recent Saves can check canonical operation markers after reload. A partial capture whose manual source cannot be confirmed remains uncertain and needs operator review before retrying. The operator must inspect Notion and the ledger; do not clear locks or create duplicate records blindly.

## Verification

Automated tests cover domain validation, pagination/schema drift, provider failures, approval/replay/concurrency, owner authorization, API constraints and a mocked end-to-end idea/manual-source capture. Browser fixtures verified collection views, review and approved capture; fixtures are interception-only and never runtime fallback data. Capture fields are disabled until hydration and use POST fallback to keep text out of URLs.

Canonical production reads, private hosting and trusted owner sign-in are verified. Core UI capture was verified and the owner confirms assistant captures. Recoverable import jobs are deployed; real owner-chosen source verification remains pending.

## Selected imports

The Sources & imports workspace supports local ChatGPT JSON and selected Claude Code/Codex JSONL files, branch preview, redaction, editable proposals, selected-only progress downloads and reviewed canonical capture. See [selected-imports.md](docs/selected-imports.md) for supported profiles, identity rules, retention and remaining work. Local staging works without a token. Live capture still requires the private runtime connection.

## Manual evaluations

Use /evaluations for the offline workbench or Evaluate from an idea to save immutable assessment history after review. Choosing an active score is separate; replacing a manual score requires a reason. See [evaluations.md](docs/evaluations.md) for snapshots, recovery and verification limits. AI provider scoring is still pending.

## Relationship review

Compare canonical pairs from Review center or staged drafts from Sources & imports. Decisions preserve canonical idea content and require exact review/approval; rejected content pairs require explicit reconsideration. See [relationships.md](docs/relationships.md). Separate approvals now add related links in both directions, with a Notion intent journal and explicit recovery for verified partial saves. Separately approved merges now preserve originals and support journaled recovery; see [merges.md](docs/merges.md). Configured semantic/AI matching and live approved write verification remain follow-up work.

Local Notion schema/dashboard/list/review reads are now verified with the configured internal integration. The owner has verified canonical capture through the UI and assistant clients.

## Selected Notion content

Sources & imports now supports an explicitly chosen page or selected rows from one data source, server redaction, ancestry/self-import protection and revision checks before approved capture. See [notion-imports.md](docs/notion-imports.md). Original source content is read-only; live chosen-source capture still requires owner verification.

## Saved extraction proposals

Selected drafts can be explicitly saved to Notion Review Queue, reopened, accepted or rejected with preserved evidence and authoritative rejection memory. Acceptance creates canonical records only after a separate approval. Recovery can finish a positively verified decision’s queue update without replaying capture. See [extraction-proposals.md](docs/extraction-proposals.md) for workflow, tests and limits. Live owner-approved writes remain open; saved manual assessment review is now implemented below.

## Saved evaluation proposals

Completed manual assessments can be explicitly stored in Review Queue, accepted into immutable history or rejected with preserved evidence. History-only remains the default; active-score replacement needs exact approval and manual override consent. Verified recovery never recreates evaluation history. See [evaluation-proposals.md](docs/evaluation-proposals.md). AI scoring and live owner-approved writes remain open.

## Consented AI assessments

A disabled-by-default Azure Responses adapter now supports selected/redacted excerpts, exact destination/policy consent, bounded single-use requests and unapproved AI results. Separate storage and acceptance approvals preserve AI provenance and protect manual scores. See [ai-assessments.md](docs/ai-assessments.md). The real runtime remains AI-disabled until a compatible deployment/key and policy are configured; no paid calls were made.

## Selected AI extraction

Staged import excerpts can now receive consented Idea/Routine/Uncertain classification and an editable candidate, with preserved provenance, shared AI budgets, human override reasons and separate proposal acceptance. Private progress v2 preserves original AI output and human edits; v1 remains readable. See [ai-extraction.md](docs/ai-extraction.md). Model configuration, live quality and semantic matching remain open; owner-driven durable import jobs are now deployed.

## Selected semantic search

Explorer now opens /ideas/semantic for explicit idea/field selection, exact transmission consent, versioned derived vectors, current-Notion-verified cosine search and separately reviewed cache clearing. Model requests remain disabled until a compatible embedding deployment and retention policy are configured. See [semantic-search.md](docs/semantic-search.md) for authority, cancellation/recovery, capacity and live-verification limits. No real embeddings or paid model calls were made.

## Complete semantic snapshots

Complete rebuilds now plan every current canonical idea, stage explicitly approved batches, verify the full manifest against Notion and atomically switch the search pointer after separate approval. Inactive snapshots can be discarded and clearing uses a transaction. See [semantic-snapshots.md](docs/semantic-snapshots.md). Labeled/live quality, hosting and scale checks remain open; no real model or Notion write was made.

## Assistant capture MVP

Six owner-authenticated MCP tools and a browser approval flow are deployed. See [assistant-capture.md](docs/assistant-capture.md) for the workflow and outstanding launch gates. The owner has verified reads and capture through ChatGPT and Claude.

## Source control

This repository is the canonical source for the private Idea Lab app (root) and its separate public OAuth transport (`claude-gateway/`). GitHub Actions runs tests, type checking and production builds on pushes and pull requests. It uploads commit-labelled release artifacts; artifact creation does not publish a Site. Changes should use branches and pull requests. Runtime secrets and Notion content are excluded. See [contributing](CONTRIBUTING.md) and [deployment](docs/deployment.md).

## Images and files

Saved idea details now include reviewed image/document attachments in Notion-managed storage, local image previews, refreshed file links and positive reconciliation for uncertain uploads. See [attachments](docs/attachments.md) for supported formats, limits, approval/recovery and rollout verification.
