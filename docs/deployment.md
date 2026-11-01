# Source control and deployment

GitHub repository: https://github.com/edrft99/idea-lab

The repository root is the production private app; claude-gateway/ is the separate public Claude OAuth transport. Preserve the two .openai/hosting.json identities. GitHub is the source of truth; make changes on branches and review pull requests. Do not develop independently in an old Sites checkout.

## Current release provenance

The app snapshot was imported from native Sites source commit d1c48555512c099af2a893ef7775bdf7ede4102f, deployed as version 9 on November 1, 2026. The original Site remains owner-private at https://idea-lab.edrft.chatgpt.site. The relay worker snapshot comes from native source commit 619f01c5ad7e854ca4b88bf1e332a33dca7c75a5, deployed at https://idea-lab-claude.edrft.chatgpt.site. Importing source into GitHub does not redeploy either service.

## Automated verification

The Verify and build GitHub Action runs for pushes to main, pull requests and manual dispatch. On Node.js 24 it installs the lockfile, runs app tests and TypeScript, builds both Workers, validates relay ESM, and packages commit-labelled artifacts with SHA-256 hashes and provenance. It uses read-only repository permissions and no runtime secrets. Artifacts expire after 14 days. A green check and artifact upload do not mean a Site was deployed.

## Publication through Sites

The current supported Sites tools do not expose an unattended GitHub Actions publishing interface or durable CI deployment credential. The owner chose on November 1, 2026 to keep Sites hosting and use GitHub checks/builds. Publication therefore remains a separate authenticated operation through Sites in Codex/ChatGPT. See https://learn.chatgpt.com/docs/sites/publishing-and-sharing. Do not use a private Site service/bypass token for deployment; it is an HTTP access credential only. A short-lived native source-repository credential is not a durable GitHub secret.

For a release:

1. Select a reviewed GitHub commit with passing checks and a clean worktree. Record its full SHA. Export only that commit's tracked source (git archive), never ignored environment files, work directories or Notion content.
2. Open the existing private Site through the supported Sites source helper using its exact manifest project_id and a freshly issued source credential passed through hidden stdin. Preserve native Site history; do not force-push GitHub history into it. Apply the exported app source in that native checkout, preserving identity and keeping excluded runtime files private.
3. Build in that checkout through the Sites helper. Push that exact native source state, package it, and save/deploy the returned source commit and archive using the owner-private operation. Retain the actual returned source provenance; do not substitute the GitHub SHA for a different native commit.
4. Poll the returned deployment until terminal. Verify bindings/migrations and the affected behavior. Record the GitHub SHA, native source SHA, saved version, deployment ID and verification limit in the issue. Preserve owner-only access and protected runtime settings.
5. For a changed relay, export only claude-gateway/ into its existing separate native checkout. Build with its scripts/build.mjs, validate the artifact, and publish through its existing public transport project. Never enable native MCP capability on this relay.

Do not publish unreviewed PR artifacts. For rollback, select an existing saved version with its matching artifact and verify database migration compatibility before deployment. Restore a source change through a reviewed revert commit as well.

Fully automatic GitHub deployment remains pending a supported Sites interface or an explicitly approved hosting change. A hosting migration must account for trusted owner sign-in, native ChatGPT MCP, Claude OAuth, database/approval state, protected settings and both domains before provisioning or cutover.
