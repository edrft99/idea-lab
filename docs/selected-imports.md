# Selected import staging

The file-based Sources & imports workflow works before Notion credentials are configured. It reads only files the owner explicitly chooses, or pasted JSON/JSONL. It does not scan directories, fetch conversation histories, upload exports, or call an AI provider during preview/staging. Optional [AI extraction](ai-extraction.md) requires its own selected-excerpt transmission consent.

## Workflow

1. Select a source format and a UTF-8 file (10 MB maximum).
2. Select a conversation and branch. Nothing is selected by default.
3. Preview redacted text. Select individual user/assistant turns, edit evidence and apply extra phrase redaction.
4. Stage up to 100 unsaved proposals. Local intent hints and title/category suggestions are deterministic helpers, not AI evaluations. Routine/uncertain turns remain manually selectable.
5. Edit each idea. Request review to send only that proposal and selected evidence to the authorized Site server.
6. Inspect the exact idea/provenance changes, then explicitly approve the Notion save.
7. Download progress before leaving. Resume the versioned JSON file later; no approval token is included.

A skipped proposal is a local draft decision, not an authoritative Notion review rejection. Restored saved IDs are hints; saved flags reset to drafts and canonical source identity is checked again. Invalid files leave existing drafts unchanged. Keep downloaded review files private; they contain selected text. There is no automatic browser persistence or remote retention of whole exports. Navigating away can discard unsaved local work.

## Profiles and limits

- ChatGPT mapping-v1: conversation arrays, single mapped conversations or conversations wrapper. Keeps parent branches and current-node selection; system/tool/hidden messages and non-text attachments are excluded. Cycles, missing parents and reused IDs fail clearly.
- Claude JSONL-v1: user/assistant records with sessionId, UUID and text/string content. Keeps parent UUIDs and file order. Tool blocks, thinking, metadata and non-text content are excluded. Local session branch selection is not yet projected into a branch graph.
- Codex JSONL-v1: requires session_meta, imports response_item message text and ignores event_msg duplicates, reasoning and tools. Message IDs are preserved when supplied. Missing IDs use original line locators; retain the original append-only file because reordering changes identity.
- Unknown shapes are rejected or counted as skipped records. These are bounded observed format profiles, not promises of universal export compatibility.
- 20,000 text turns, 50,000 JSONL lines, 1,000 conversations/branches, bounded graph traversal and 25-turn preview pages. Each selected evidence excerpt must be 1–6,000 characters.
- One proposal per selected turn or Notion excerpt in this implementation. Splitting one turn into multiple ideas and combining evidence from several turns remain follow-up work.
- ZIP archives, GitHub collectors, semantic matching remain follow-up work. Optional selected-excerpt AI extraction is now available behind separate consent. Selected Notion pages/data-source rows now use the separate selector described in [notion-imports.md](notion-imports.md).

## Canonical identity and failure behavior

Conversation Source Key is SHA-256 of system/conversation/message identity; Notion blocks use global block identity and properties use page/property identity. Identity does not depend on generated idea text, redaction or adapter version. Source Revision hashes selected evidence, role, date, URL, locator, adapter version and the external revision for Notion. Source Identifier retains conversation/message IDs. Unknown dates and absent original URLs remain null; no link is invented.

Under the operational source lock, the application rechecks Notion before creating. A repeat or changed source returns a conflict and canonical links, rather than creating another source or silently overwriting history. Source uniqueness is enforced within this application's serialized path, not as a Notion database constraint; external edits or writers still require review.

The approved save creates the idea and a linked source containing selected redacted evidence, stable identity/revision, adapter version, actual capture time and operation marker. Manual scores and evaluation history are untouched. D1 retains only operational hashes/IDs/status and locks; no conversation payload is stored there.

If the idea or source outcome is ambiguous, its lock remains and Recent Saves can reconcile operation markers. Missing/partial provenance is not blindly retried. Durable owner-driven checkpoints, bounded leases/attempts, pause/cancel/resume and exact recovery of proven missing steps are now implemented; see [recoverable import jobs](import-jobs.md). Ambiguous dispatches remain blocked until a positive result or operator inspection. Unattended scheduling and full live chosen-source validation remain open. Authoritative rejection is available through saved proposal review; local skips remain local.

## Evidence and verification

317 application tests now include initial CRUD plus branch parsing, role/tool boundaries, malformed formats, redaction, checkpoint validation, stable/changed source revisions, concurrent receipts, source-lock retention and complete manual/imported capture against a mocked Notion provider. File-preview and local-staging checks verify zero POSTs; selected Notion preview is an explicit server read. Other browser checks cover selected-only checkpoints, explicit review/save, resume, canonical links for repeats, malformed files, desktop/mobile and dark appearance. Local Notion reads are verified; approved real captures remain a live verification gate. No real conversation fixtures or Notion writes were used.

Format references (the parsers validate their supported profile rather than assuming every export matches):

- [OpenAI export guidance](https://help.openai.com/en/articles/7260999-exporting-your-chatgpt-history-and-data)
- [OpenAI export transfer guidance](https://help.openai.com/en/articles/9106926-transfer-exported-conversations-between-chatgpt-accounts)
- [Codex response item definitions](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/models.rs)
- [Codex session protocol](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs)
- [Claude Code transcript path in hooks](https://code.claude.com/docs/en/hooks)

## Notion document sources

Notion excerpts use document role, stable page/block/property identities and explicit external revisions. Preview is an owner-authorized server read; file previews remain local. Nothing is selected or saved automatically, and no AI provider receives content. Complete selection/privacy/recovery bounds are documented in [notion-imports.md](notion-imports.md).

## AI extraction and private progress v2

Selected excerpts can be classified as Idea, Routine or Uncertain after explicit destination/content/policy review. The result, original source and human-edited draft remain local until a separate proposal-storage approval. Routine/Uncertain overrides require a reason. New progress downloads use version 2 to preserve AI provenance; legacy version 1 files remain readable. No approval token is exported. See [ai-extraction.md](ai-extraction.md) for proof, canonical source history, limits and verification.

## Recoverable import jobs

Optional tracking keeps metadata only on the server and selected text in the private progress file. Progress v3 carries a non-authorizing job reference; v1/v2 remain readable. Each canonical save and missing-step recovery still needs exact approval. See [import-jobs.md](import-jobs.md) for leases, attempt budgets, replay protection, retention and verification limits.
