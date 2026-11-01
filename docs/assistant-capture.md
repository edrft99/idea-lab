# Assistant capture MVP

Notion is canonical. The private Site provides six MCP tools at POST /mcp: search_ideas, get_idea, propose_idea, save_idea, update_idea and find_similar_ideas. The last uses explicitly labeled keyword overlap. No model or embedding API key is required for capture.

## Capture flow

1. Ask the connected assistant to capture one selected idea. It searches existing ideas and proposes the selected fields and relevant evidence.
2. Open the returned Idea Lab review link. Sign in as the configured owner. Review every field and source detail, check the approval box and choose **Approve and save in Notion**.
3. The website executes the shared canonical save. Ask the assistant to check save_idea using the same proposal ID for the canonical link. Never generate a new capture ID to retry an uncertain save.

Claude chat, Claude Code, ChatGPT and Codex are separate source labels. Source IDs supplied by a client are provenance claims, not authorization. Missing original conversation/message IDs are explicitly recorded as unknown; a synthetic capture locator identifies only this capture.

Updates require current canonical revision and full editable fields. They preserve existing manual scores, sources and evaluation history. No automatic merge or delete is exposed.

## Approval and retention

Owner identity comes from trusted Sites authentication. MCP has no approve tool. Native client permissions, tool metadata, assistant statements and proposal IDs cannot grant website approval. Approval POSTs require the owner and the Site's Origin. Exact actor, payload and revision are checked again by the shared command service. Uncertain writes are reconciled without blind replay.

D1 migration 0003 adds an owner-scoped, temporary selected-draft table. Only the selected normalized command is staged, for five minutes, up to 20 active drafts per owner. Review URLs contain only an opaque proposal ID. Draft text is inaccessible from the server after expiry. Payload and approval are cleared after save/rejection, or on subsequent capture access after expiry. There is no unattended cleanup job yet; dormant expired text can remain physically stored until subsequent access. Hashes and operation metadata remain for deduplication/recovery. This table is disposable staging, never the authoritative idea record. No whole conversation is uploaded.

## Launch gates

- Push the reviewed source and publish the existing owner-private Site, preserving its audience.
- Configure NOTION_TOKEN in protected hosted runtime settings; local .env.local is never uploaded. Verify production owner identity, all four data-source reads, DB binding and migrations 0000–0003.
- Obtain the exact MCP endpoint and connection resource from the published Sites response. Do not invent a URL or reuse a source Git endpoint.
- Connect ChatGPT through the published private app/custom MCP flow and test authenticated discovery and a read.
- Verify Claude chat's remote MCP authentication against that endpoint separately. Its cloud connector cannot reach localhost. Native Sites OAuth compatibility with Claude has not been established. Do not reuse a privileged Sites bypass credential as a client secret.
- Perform one real, owner-approved capture from each requested client and verify its canonical idea, source provenance and replay behavior. No synthetic records belong in the live databases.

## Verification status

Local automated tests exercise the real MCP routes and browser approval routes against synthetic Notion and SQLite fixtures: owner authorization, protocols, strict arguments, Origin checks, staging, browser-only approval, canonical save and replay. Real hosted authentication, Claude compatibility and live capture remain unverified. A source build or passing test is not evidence of a connected client.
