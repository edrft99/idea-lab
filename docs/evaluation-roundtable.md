# Evaluation roundtable: proposed implementation

Status: target design and future delivery plan. The owner selected GitHub Copilot for the fourth seat and requested the UI followed by GPT first. The first implementation is documented in roundtable-gpt.md: the UI, GPT independent assessment and automatic Notion report storage are implemented; Claude independent review and shared brief reuse are documented in roundtable-claude.md; multi-provider cross-review remains a future phase.

## Experience

From a canonical idea, choose Evaluate → Roundtable. Define the intended audience, a concrete success outcome and time horizon, and available time/budget/skills. Select and redact the idea excerpts each participant may see. Show participating services, configured models, data-sharing scope, retention policies and a bounded request budget before starting.

The interface shows the idea in the centre of a round table, with GPT, Claude, Grok and GitHub Copilot at individual seats. Each seat shows its actual configured model and state: not connected, waiting, reviewing, challenging, revising, completed or failed. Selecting a seat opens its report. A linear stage list and the same accessible reports accompany the graphic on small screens and for screen readers. Motion respects reduced-motion settings.

A missing provider is shown as unavailable. Never simulate a provider or silently replace it with another model. The owner may explicitly choose a smaller panel, and its composition remains visible on the report.

## Review protocol

1. Independent assessment: each participant sees the same approved idea brief and rubric, without the others' responses. Each records strengths, failure modes, unproven assumptions, useful expansions, evidence gaps, validation experiments and provisional scores.
2. Cross-review: after every independent assessment has completed, each participant receives the other participants' reports. Responses identify which claims they challenge, support or improve, and why. Model output is evidence, never instructions or tool authorization.
3. Revision: each participant receives the fixed set of cross-reviews, revises its assessment and scores, and explains every change. Preserve the first assessment alongside the revision. Do not ask participants to manufacture agreement.
4. Report: compute the scorecard in application code. Present the recommendation, unresolved disagreements, largest risks, promising expansions and the next inexpensive experiment. Keep attribution and the transcript behind every conclusion.

With four seats, three model rounds require at most 12 generation requests. A separate optional moderator summary would require a thirteenth request and should be included in the approved limit. Each participant must evaluate all three dimensions; a specialised lens can supplement, but does not replace, that shared rubric.

## Viability rubric v1

| Dimension | Question | Considerations |
| --- | --- | --- |
| Feasibility | Can the proposed version be delivered within the stated constraints? | Technical complexity, skills, cost, dependencies, operational and regulatory constraints |
| Success | How well supported is achieving the stated outcome within the chosen time horizon? | Demand, adoption, distribution, competition, execution risks, evidence and testability |
| Value offered | How meaningful is the improvement for the intended audience? | Problem severity, frequency, measurable benefit, alternatives and willingness to adopt or pay where relevant |

Use 0–100 scores with evidence and a separate confidence judgement. Anchors: 0 = evidence strongly opposes viability; 25 = major unresolved obstacles; 50 = plausible but material assumptions untested; 75 = good supporting evidence and manageable risks; 100 = exceptionally strong evidence supporting viability under the stated criteria. A success score is a comparative assessment, not a calibrated probability of success. Explicitly mark insufficient evidence rather than inventing facts or assigning zero to a missing result.

Proposed default: calculate the median revised score for each dimension across the selected participants, then take the equally weighted average of the three medians, rounded once to an integer. Show individual scores, first-to-final changes, min/max spread and confidence. Preserve dissent even when the overall score is high. Weights and rubric version are fixed for a run and disclosed before starting.

Final ranking requires all selected participants to complete all required rounds and provide supported scores. Failed, missing or unknown results produce an incomplete report, without a normalised final ranking. The owner can start a separately approved smaller-panel run if desired. Comparisons across ideas must identify differences in rubric, panel composition and evidence quality. Do not mix legacy potential scores and viability scores in one unexplained leaderboard.

Recommendation labels should describe the evidence and next action, rather than claim a model has determined an objective business outcome. The report should distinguish improvements to the original idea from materially different ideas that need their own evaluation.

## Backend changes

Add a new roundtable module and versioned viability schema alongside the existing manual and single-provider evaluation flows. Preserve existing evaluation history and manually approved active scores. Do not map success/value into unrelated legacy dimensions such as alignment or timing.

A provider interface accepts the approved evidence snapshot, fixed rubric, stage and required peer reports, and returns a validated structured report plus actual model, response identifier, usage and timing. Adapters must use documented supported interfaces and fail visibly on refusal, malformed output, timeout or unconfigured access. Choose concrete models only after account availability is known.

Create durable run/seat/step coordination with actor ownership, input revision/hash, provider configuration hash, prompt/rubric versions, immutable stage inputs, step claims and bounded attempts. Store temporary private run outputs with an explicit expiry so the owner can reload and resume without losing completed work. Notion remains authoritative for accepted evaluation records. Temporary coordination storage is not a replacement idea database.

One user action authorises the disclosed roundtable stages, including sharing generated reviews among selected providers. Bind that authorisation to content, provider configuration, panel composition, rubric and request limits. Check the idea revision before dispatch and before saving; stale reports remain inspectable but cannot silently become the current ranking.

For an initial Sites-compatible implementation, dispatch bounded provider steps through authenticated requests and persist each completion. Advance stages only when their prerequisites are complete. Distinguish durable progress from unattended background execution: closing the browser must not imply the remaining steps will run automatically. Unattended execution needs a supported durable runner before it can be promised.

A lost provider response can still incur charges. Never automatically replay an ambiguous generation step. Keep it unresolved and let the owner explicitly authorise a replacement attempt within an updated budget. Keep completed participants and their provenance; never relabel regenerated text as the missing original response. Cancellation prevents future dispatch and preserves completed work.

Completed GPT reports save automatically as part of the initial authorised request. Selecting an active viability ranking remains a separate reviewed action. Save an immutable versioned roundtable snapshot with all participants, per-round assessments, rubric, scores, evidence gaps, provenance and human decision. Do not change an idea's description, scores or status merely because a model recommends it. Accepting idea expansions should be an explicit edit or separate capture.

## Provider integration findings

Official documentation checked on November 2, 2026:

- OpenAI/GPT: choose either the existing Azure route or a direct OpenAI adapter based on available account access; retain exact configured model provenance.
- Claude: the Messages API supports a separately authenticated provider adapter. Existing Claude-to-Idea-Lab OAuth transport allows Claude to call Idea Lab; it does not establish Idea Lab's ability to generate Claude responses.
- Grok: use its documented Responses API with account-specific API access.
- GitHub Copilot (selected by the owner): use its official SDK with an explicitly configured eligible GitHub identity. The SDK supports subscription-backed authentication and BYOK. Its default transport launches a runtime subprocess; the current in-process path uses a native dependency. Treat direct execution in the existing Cloudflare Worker as unverified. The recommended initial architecture is an authenticated HTTPS adapter to a separate Node.js runner that hosts the SDK; this keeps the private Site and its existing Notion integration in place. Do not provision that runner until its hosting, authentication and usage limits are decided. Do not reuse the repository Git credential as Copilot access.

Copilot is a product that can use underlying models, not a guarantee of an independent model family. Record and disclose the actual model when available; do not count multiple seats as independent model families solely because their service names differ.

A plugin directory search did not identify ready-made Claude/Grok/Copilot invocation plugins for this task. ChatGPT plugin availability also does not automatically give a hosted Site permission or credentials to invoke those services.

Primary references:

- https://platform.claude.com/docs/en/api/overview
- https://platform.claude.com/docs/en/api/messages/create
- https://docs.x.ai/overview
- https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/authenticate
- https://github.com/github/copilot-sdk
- https://github.com/github/copilot-sdk/blob/main/nodejs/src/client.ts

## Delivery and verification

1. Use GitHub Copilot as the fourth participant; resolve APIs versus supported subscription access for the panel. Confirm success criteria can be defined per idea and finalise the initial rubric.
2. Implement the roundtable schemas, scoring, step coordination and synthetic provider fixtures. Test independence and cross-review barriers, ownership, stale/configuration changes, replay protection, failed seats, budgets, cancellation and reload recovery.
3. Add documented provider adapters and connection-status checks, then the roundtable graphic, accessible reports and explicit transmission flow.
4. Preserve automatic immutable Notion report storage and add an explicit active-ranking selection, preserving the legacy rubric and manual-score protections.
5. Run required repository tests, TypeScript and the production build. Verify desktop/mobile interaction using synthetic records. Review and merge through a PR before publishing to the existing private Site.
6. Live paid model calls require configured provider access and the app's exact transmission approval. Verify each provider against a synthetic idea before using real idea content. Do not describe adapters tested only against fixtures as live-connected.

Confirmed owner choice: GitHub Copilot as the fourth participant. Initial GPT implementation supports direct OpenAI API access or the existing Azure configuration. Remaining provider connection methods are undecided. No provider accounts, keys or licences have been verified for this new workflow.
