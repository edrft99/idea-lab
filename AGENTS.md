# Idea Lab repository instructions

GitHub is the canonical source for the app at repository root and the separate Claude relay in claude-gateway/. Use branches and pull requests after bootstrap. Preserve unrelated changes.

Keep Notion authoritative; preserve owner authentication, exact review approval, idempotency and uncertain-write recovery. Use synthetic fixtures for automated checks. Never store runtime credentials, real idea content or local progress files in this repository or CI artifacts.

Run npm test, npm run typecheck and npm run build for relevant app changes. Build/validate the relay for transport changes. Preserve vendor licenses.

No push, publication, provisioning or existing Notion changes without user authorization. Preserve the current private app audience and separate public transport. Do not create replacement Sites, invent deployment endpoints or reuse a Sites service token as a deployment credential. See docs/deployment.md.
