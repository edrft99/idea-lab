# Claude OAuth connection

## Status

Deployed on 2026-11-01 after owner approval. The private Idea Lab Site is version 8 from 9186b5565555eeb8ac74e1cc3fe8134c0850aba0 (environment revision 5). The separate public relay is version 1 from 619f01c5ad7e854ca4b88bf1e332a33dca7c75a5 (environment revision 1), at https://idea-lab-claude.edrft.chatgpt.site/api/claude/mcp. The original Site remains owner-private, with no groups or external visitors. Hosted migration 0004 is applied. All 468 tests, TypeScript and the production build pass. Live discovery, anonymous MCP rejection, invalid-grant rejection, route allowlisting, owner-consent redirect and signed-in consent rendering are verified. The owner now confirms Claude connected after approving access. Production evidence shows an active session for the pinned client/resource with both scopes, token exchange 200, server discovery 200 and tool listing 200. A real read-only Claude search is verified: the owner confirms matching ideas, and production logs show tools/call search_ideas HTTP 200. The authentication goal is complete. Capture/provenance/replay, refresh and live revocation remain broader MCP verification items. The active working connection is preserved.

## Deployment boundary

Claude connects to a separate public Worker Site at /api/claude/mcp. This relay has no D1, R2, Notion key, idea snapshots or native Sites MCP capability. It forwards only a fixed OAuth/MCP route allowlist to the original private Site. Incoming cookies, identity headers and supplied service credentials are stripped. Arbitrary upstream URLs and redirects are rejected. The original Site keeps its owner-private audience and its existing ChatGPT MCP endpoint.

The relay holds the original Site's existing service credential and an independent 256-bit relay key in protected server-only settings. The private Site requires the relay key and validates the separate Claude OAuth token. Claude never receives either service credential or the Notion integration key.

## Owner consent and permissions

Only the configured Idea Lab owner may approve a connection after signing in to the private Site. The consent view binds the actor, client, resource, scopes, callback, PKCE challenge and expiry to an exact review hash. Approval starts disabled until the owner checks the consent box. Denial returns no code.

Only Claude's published client identity is accepted: https://claude.ai/oauth/mcp-oauth-client-metadata. Metadata is fetched from that pinned HTTPS URI with no redirects and bounded size/time. The callback is pinned to https://claude.ai/api/mcp/auth_callback. No dynamic client registration or arbitrary client ID is accepted. OAuth metadata advertises published-client support and public-client token authentication with PKCE S256.

Scopes are ideas:read (search/read idea and source metadata) and ideas:capture (stage selected drafts/updates and inspect approved-save status). The MCP catalog and tool dispatch enforce the granted scopes. Claude capture is labeled Claude. An OAuth connection does not approve any Notion mutation: exact website approval of each staged save remains required. Imported content is never consent.

## Lifetimes and revocation

- Consent request: five minutes; authorization code: at most 60 seconds, one use, bound to PKCE, client, callback and resource.
- Access token: 15 minutes; refresh/session: at most 30 days from initial approval.
- Only SHA-256 token/code hashes are stored. Refresh tokens rotate; reuse revokes the entire session family. Concurrent code claims use atomic D1 batches; transactional storage is required.
- Settings can revoke an owned connection. OAuth revocation accepts an access or refresh token. Both stop future use of the session and preserve ideas, sources and save history.
- Owner configuration changes invalidate access for the previous owner. Limits are 20 active sessions per owner, 50 pending requests and 500 authorization requests per day.
- New authorization requests opportunistically remove at most 100 authorization rows expired over a day ago and tokens/sessions for at most 100 sessions expired over a day ago. This is not a scheduled cleanup job; metadata can remain longer while idle.

## Deployment checklist after approval

1. Export claude-gateway into its own checkout. Register one new Site, persist that new project ID in its manifest, and approve a public audience for that relay only. Never reuse the private Site project ID.
2. Configure the private Site with IDEA_LAB_CLAUDE_ORIGIN (the exact new HTTPS origin) and protected IDEA_LAB_CLAUDE_RELAY_KEY. Preserve the existing owner and Notion settings.
3. Configure the relay with IDEA_LAB_SITE_ORIGIN (the exact private Site origin), the same protected relay key, and protected IDEA_LAB_SITE_SERVICE_TOKEN. Do not place any of these secrets in source, archives, browser forms for Claude, or logs.
4. Publish the private Site update, applying migration 0004 for authorization requests, sessions and token hashes. Publish the relay using its own source/package workflow; build with node scripts/build.mjs after registration.
5. Probe public OAuth discovery and anonymous MCP 401 through the actual hosting edge. Verify no anonymous tool data, secret or cookie is returned. Check ChatGPT's existing endpoint still works.
6. Add the new relay MCP URL in Claude and choose its published identity. The owner reviews and approves the real connection in the private Site. Verify search, selected-draft staging, separate exact save approval, source attribution, refresh and revocation with real Claude before claiming completion.

Do not tell the user the connector is working based only on the local synthetic flow.

## Verification evidence

The 468-test suite includes relay header stripping and redirect bounds, code replay/concurrency, missing transactional storage, PKCE/resource/callback checks, concurrent refresh reuse and fixed session expiry, owner changes, expiry, scopes, revocation, transactional rollback, request caps and bounded metadata. An end-to-end synthetic test exercises relay → authorization → owner consent → token → shared MCP → separate save approval → one canonical idea/source → replay → revocation. No real model calls or Notion writes are used.

Browser QA used an isolated proxy that blocks real grants and Notion writes: approval disabled → checked/enabled → unchecked/disabled, fixture-only revocation, and mobile layout without horizontal overflow. Screenshots and logs are ignored local work artifacts. The production build and TypeScript check pass.

## Rollback

Revoke Claude sessions and remove the relay's public audience or disable its deployment to stop new connections. Remove the protected relay settings from both Sites if retiring it. The original native ChatGPT endpoint and canonical Notion records remain independent. Preserve the operational tables until grant revocation/audit retention is resolved; do not delete records as part of rollback.

## Production runtime repair

The first deployment exposed a Worker-only failure before consent: Cloudflare rejects redirect mode error before sending the metadata request. The repair uses manual mode, rejects any redirected metadata response, and retains the pinned HTTPS identity. Regression coverage enforces no redirect following. Authorization failures emit only bounded stage/code/reason diagnostics, never request state, codes, tokens or metadata bodies.

Cloudflare reference: https://developers.cloudflare.com/workers/runtime-apis/request/

## References

- Claude authentication requirements: https://claude.com/docs/connectors/building/authentication
- Claude published identity: https://claude.ai/oauth/mcp-oauth-client-metadata
