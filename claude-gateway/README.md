# Idea Lab Claude OAuth relay

This is the deployed public OAuth transport at https://idea-lab-claude.edrft.chatgpt.site/api/claude/mcp. The owner has verified sign-in, reads and capture through Claude. The private app remains at https://idea-lab.edrft.chatgpt.site.

The worker forwards a fixed route allowlist. No Notion credentials, idea snapshots or OAuth token database are stored here. OAuth grants and commands remain in the private app. Runtime secrets IDEA_LAB_SITE_SERVICE_TOKEN and IDEA_LAB_CLAUDE_RELAY_KEY never belong in GitHub. Configure IDEA_LAB_SITE_ORIGIN at runtime.

Do not enable native Sites MCP capability here. Claude uses its own /api/claude/mcp OAuth resource. Preserve the existing project identity in .openai/hosting.json. Export this directory into a separate Sites checkout before supported publication; do not register a replacement project. Build with npm run build and validate with node scripts/validate-artifact.mjs. See ../docs/deployment.md.
