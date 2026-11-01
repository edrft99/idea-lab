# Selected Notion content imports

The Sources & imports workspace can read one page you explicitly name, or let you choose rows from one Notion data source. This uses the server's protected internal integration and owner authorization. It does not search the workspace or discover personal pages automatically.

## Selection and preview

For a page, paste its Notion HTTPS URL or UUID and click Preview selected Notion page. For a data source, use its data-source ID, click List 25 row titles, then choose up to five visible rows and click Preview chosen Notion rows. No rows or excerpts are selected by default. Next-page metadata replaces the visible row selection; it does not silently collect all rows.

Row queries request title properties only. Ancestor page checks also request title properties only; parent/schema metadata is checked to exclude Idea Lab. Other ancestor content is discarded rather than returned or retained. Page bodies load only for chosen pages. Supported nested blocks are opt-in. Child pages, child databases, linked pages, synced blocks, files, embeds and attachments are never followed.

Only selected page text is returned to the browser. Common credential/email/path patterns and the actual configured integration key are redacted on the server. Credential-bearing page URLs are withheld rather than returned as links. Pattern matching cannot identify all sensitive information; check and edit every selected excerpt and use additional phrase redaction.

Selected page text is treated as document evidence, not as user/assistant messages, instructions, tools or approval. Imported markup is rendered as text. No AI endpoint is called.

## Supported content and bounds

Text properties are read through their paginated property-item endpoints, including when the page response gives no has_more hint for inline mentions. Child blocks and long relation properties are paginated. Relation references are counted but their linked pages are not loaded.

Supported text: paragraphs, headings, bullet/numbered lists, checklists, toggles, quotes, callouts, code and table rows. Columns and tables are traversed only with nested-block selection. Non-text properties and unsupported blocks are reported rather than silently treated as complete imported content.

Bounds per content preview: five selected pages, 500 blocks, nesting depth five, 20 ancestors, 120 provider reads, 1,000 items in a paginated property, 50,000 characters per excerpt and 300,000 total characters. Larger selections fail clearly; partial results are not accepted. Each staged excerpt must still be shortened to 1–6,000 characters, and a local review batch has at most 100 proposals. Metadata listing is one 25-row page per explicit request.

The integration must already have access to the selected source and its ancestors. The app does not broaden that access. Configure the Idea Lab hub and four database URLs in addition to the four data-source IDs so self-import protection can fail closed.

## From source text to an approved idea

Choose individual excerpts, edit/redact evidence, then stage unsaved proposals using the existing local workflow. Staging makes no application API request. Draft titles/categories are deterministic suggestions, not AI extraction. Existing drafts and checkpoints remain browser-local and selected-only.

Requesting a review sends one proposal's displayed fields and selected evidence. An explicit final approval creates the canonical Idea and Source. The original source page, properties, blocks and relationships are never modified. Source provenance is retained in the new Source's existing fields and a selected-source JSON snapshot in its body; no schema changes were made.

Notion block identity uses the normalized globally stable block UUID, independent of parent-page moves. Property identity uses normalized page UUID + decoded stable property ID. They do not change when evidence is redacted or an idea title is edited. External revisions are retained separately and included in the source revision digest. Existing conversation-source hashes remain compatible.

The original page/property or block revision, provenance link and ancestry are checked before review and again inside the approved write's source lock. Changed, moved, archived or unavailable sources stop the save before canonical mutation. Repeated or changed canonical source identities return the existing conflict flow rather than creating duplicate sources.

If an existing local draft refers to an older Notion revision, download any work you want to preserve, clear the stale local batch and load the current source again. Automatic replacement of an edited local draft is not provided. Local skips remain local; authoritative extraction rejection and durable background jobs remain separate work.

## Verification and deployment

193 tests across 20 files, TypeScript and the production Sites Worker build pass. Tests cover self-import/ancestry guards, metadata filtering, property/block pagination, redaction, URL refusal, unsupported content, stale/moved sources, scope substitution, API authorization and selected-source snapshot persistence.

A synthetic browser server verified no reads before selection, metadata then one chosen row, no API request during staging, one review containing only the chosen block/revision, inert markup, local-session cleanup and mobile layout. Canonical mutations were disabled on that QA server and no final save was submitted. Actual local runtime checks confirmed live schema reads and a 409 self-import rejection without reading a personal source page.

A real user-selected source and owner-approved capture, hosted identity/storage/secrets, source synchronization and production deployment remain separate verification gates. This checkpoint is preserved locally; managed Site source synchronization remains unresolved.

API references: [retrieve a page and filter properties](https://developers.notion.com/reference/retrieve-a-page), [query a data source with selected properties](https://developers.notion.com/reference/query-a-data-source), [retrieve a block](https://developers.notion.com/reference/retrieve-a-block).
