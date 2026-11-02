# Claude independent roundtable review

Claude joins GPT as an independent reviewer. Select its vendor icon to reuse GPT’s last loaded assessed brief: the same selected excerpts, success criteria, constraints, rubric, equal weights and response schema. Only the speaker name differs in the instructions. GPT’s answers are not sent to Claude. The reused brief remains visible and editable before the separate provider request review; edits apply to the next request, not a stored report. Cross-review and panel consensus remain future work.

Each seat retains its own feasibility, success and value scores, evidence and automatically saved Notion reports. Reopening an idea restores the latest available report for each reviewer (preferring the current idea revision); historical reports are labelled. Existing GPT reports remain compatible. Active idea scores are unchanged.

## Protected runtime configuration

Configure in the existing private Site’s protected environment settings, never in source, idea content or chat:

- `IDEA_LAB_CLAUDE_API_KEY`: an Anthropic API key. The existing Claude OAuth relay key and Claude subscription are separate.
- `IDEA_LAB_CLAUDE_MODEL`: a model available to that Anthropic account supporting JSON schema structured outputs through `output_config.format` on the Messages API.
- `IDEA_LAB_CLAUDE_RETENTION_NOTICE`: the actual retention terms for the account. Do not imply zero data retention without that account arrangement.
- Optional `IDEA_LAB_CLAUDE_MAX_OUTPUT_TOKENS` (default 4096, range 2000–8000) and `IDEA_LAB_CLAUDE_TIMEOUT_MS` (default 45000, range 1000–60000).

Claude uses the existing shared `IDEA_LAB_AI_REQUESTS_PER_HOUR` budget (default 5). Missing or invalid settings show Connection needed and disable sending. No provisioning or migration is required. No changes are made to the separate Claude relay.

Requests go only to `https://api.anthropic.com/v1/messages`, with redirects disabled, API version `2023-06-01`, one non-streaming user message, no tools, and JSON schema structured output. No prompt caching is requested. Anthropic has no OpenAI `store=false` option; the UI shows the configured Anthropic policy. Provider responses are bounded, validated and redacted before use. Refusals, truncated output and tool content are rejected. Requests are not automatically retried.

## Storage and recovery

The existing review datasource stores immutable reports, and the operational ledger stores status and hashes. Claude uses `roundtable-claude` generation operations; exact approvals bind provider configuration, credentials and input. Automatic report saving retains existing idempotency, source verification, idea locks and uncertain-write reconciliation. A GPT approval or result cannot be relabelled as Claude. Checking status or retrying storage never calls a model again.

## Validation

Synthetic tests cover identical GPT/Claude prompt payloads and rubric, provider response handling, secret redaction, configuration, approval isolation, shared budget accounting, auto-save, history and uncertain-write recovery. Browser QA exercises GPT → Claude prompt reuse, separate scores, reopening both reviewers and mobile layout without live provider calls or Notion writes. Live Anthropic generation requires protected configuration and an owner-reviewed request.
