# Grok independent roundtable review

Grok joins GPT and Claude with its own feasibility, success and value scores, supporting evidence and automatically saved report history. Selecting Grok reuses the loaded GPT brief, falling back to the loaded Claude or Grok brief when GPT has no report. The same evidence payload, instructions (apart from the reviewer’s name), rubric, equal weights and JSON schema are used across providers. Peer answers are not included. The brief remains editable before the owner reviews and sends the request.

All three reviewers’ latest available scores restore when an idea is reopened. Reports for the current idea revision are preferred; older versions are labelled historical. Existing GPT/Claude reports remain compatible. Cross-review and panel consensus remain future work; GitHub Copilot remains a placeholder seat.

## Protected runtime configuration

Add these settings to the existing private Idea Lab Site, never to chat, idea text or source:

- `IDEA_LAB_GROK_MODEL`: an xAI API model supporting JSON schema structured outputs on Chat Completions.
- `IDEA_LAB_GROK_API_KEY`: an xAI API credential. A consumer Grok/X subscription does not supply this API credential.
- `IDEA_LAB_GROK_RETENTION_NOTICE`: the actual data retention terms for the xAI API account. Do not claim zero retention unless the account arrangement provides it.
- Optional `IDEA_LAB_GROK_MAX_OUTPUT_TOKENS` (4096 by default; range 2000–8000) and `IDEA_LAB_GROK_TIMEOUT_MS` (45000 by default; range 1000–60000).

Missing or invalid configuration shows Connection needed and disables sending. Grok shares the existing `IDEA_LAB_AI_REQUESTS_PER_HOUR` limit (default 5) with the other AI requests. Runtime settings must be applied by deploying a saved version. No new datasource or database migration is needed.

## Provider and storage behavior

The server calls only `https://api.x.ai/v1/chat/completions` with bearer authentication, redirects disabled, one non-streaming completion and a strict `response_format.json_schema`. It sends no tools, search configuration or peer reviews. Provider retention and automatic caching follow the xAI account policy; this integration makes no zero-retention claim. See https://docs.x.ai/developers/model-capabilities/text/structured-outputs and https://docs.x.ai/developers/model-capabilities/legacy/chat-completions.

Responses are bounded, secret-redacted and validated. Truncation, refusals, tool calls, malformed reports and ambiguous provider responses never produce stored scores. There is no automatic model retry. Owner approval binds exact input and connection configuration; approvals cannot be swapped between reviewers.

Generation uses `roundtable-grok` ledger entries. Reports use the existing immutable Notion snapshots and automatic save/reconciliation flow. Reopening history, checking request status and retrying storage do not regenerate a report. Active idea scores remain unchanged.

## Verification

Synthetic tests cover the shared prompt/rubric, response bounds and failures, secret redaction, configuration, request isolation, AI budget counting, automatic saves and uncertain-write recovery. Browser QA checks GPT → Claude → Grok brief reuse, separate vendor scores, all three reviewers after reload and a 390px mobile layout. Live xAI generation remains unverified until protected configuration is supplied and the owner reviews a real request.
