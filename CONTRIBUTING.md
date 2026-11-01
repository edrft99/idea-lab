# Contributing

Use a feature branch and pull request against main. Describe the behavior changed and relevant verification; link the issue. CI must pass before review and publication.

Use Node.js 24, npm run install:ci, npm test, npm run typecheck and npm run build. Validate relay changes with npm --prefix claude-gateway run build and node claude-gateway/scripts/validate-artifact.mjs. Tests use synthetic fixtures and require no production secrets.

Keep runtime keys in ignored local environment files or Sites protected settings. Never commit Notion exports, user progress files, build output or private operational logs. Preserve both Site identities and the private app audience. Notion remains authoritative. Owner approval is required before canonical writes, new resources or publication.

Publish from a clean reviewed GitHub commit through the supported Sites workflow. Record the GitHub commit, native source commit, version and deployment result in the relevant issue. See docs/deployment.md for platform limits.
