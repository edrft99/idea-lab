import { RoundtableConfiguration } from "@/components/roundtable/configuration";
import { ClaudeConnections } from "@/components/claude-auth/connections";
import { AIConfiguration } from "@/components/intelligence/assessment";
import Link from "@/components/navigation-link";
import { RecentSaves } from "@/components/ideas/operations";
import { ConnectionStatus } from "@/components/ideas/connection";
import { workspaceLinks } from "@/lib/workspace";
import { chatGPTSignOutPath } from "@/app/chatgpt-auth";
export default function Page() {
  const links = workspaceLinks();
  return (
    <div className="page narrow-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">YOUR LAB, YOUR PRIORITIES</div>
          <h1>
            A considered foundation<span>.</span>
          </h1>
          <p>
            Notion owns the records. Sites handles sign-in. You approve changes.
          </p>
        </div>
      </div>
      <ConnectionStatus />
      <section className="panel prose-panel mt-panel">
        <h2>Capture from ChatGPT or Claude</h2>
        <p>
          Ask your connected assistant to capture one selected idea. Open its
          Idea Lab review link, check the exact fields and source, then approve
          the Notion save here.
        </p>
        <p>
          No model API key is required for capture. Assistant connections must
          be configured and verified separately after this private Site is
          published.
        </p>
        <p className="subtle-note">
          Only the selected draft is staged for five minutes. It cannot be saved
          by an assistant without your website approval. Expired draft text is
          cleared on subsequent capture access; there is no unattended cleanup
          job yet.
        </p>
        <Link className="text-link" href="/ideas/new">
          Capture an idea manually
        </Link>
      </section>
      <RoundtableConfiguration />
      <AIConfiguration />
      <ClaudeConnections />
      <RecentSaves />
      <section className="panel prose-panel mt-panel">
        <h2>Authoritative workspace</h2>
        <div className="workspace-database-links">
          {links.databases.map((d) =>
            d.url ? (
              <a key={d.name} href={d.url} target="_blank" rel="noreferrer">
                {d.name}
              </a>
            ) : (
              <span key={d.name}>{d.name}: link not configured</span>
            ),
          )}
        </div>
        {links.hub && (
          <a
            className="text-link"
            href={links.hub}
            target="_blank"
            rel="noreferrer"
          >
            Open Idea Lab in Notion
          </a>
        )}
      </section>
      <section className="panel prose-panel mt-panel">
        <h2>Potential scoring</h2>
        <Link className="text-link" href="/evaluations">
          Open scoring workbench
        </Link>
        <p>
          Impact 30% · Alignment 25% · Feasibility 20% · Reusability 15% ·
          Timing 10%.
        </p>
        <p>
          Potential = Σ ((rating − 1) × weight) × 25. Effort and readiness stay
          separate. Manually approved evaluations append history and can replace
          an active score only after review. AI assessment requires a separately
          configured deployment and selected-content transmission consent.
        </p>
      </section>
      <section className="panel prose-panel mt-panel">
        <h2>Identity and approval</h2>
        <p>
          Only the configured Site owner can access the shared Notion
          connection. Saves require review of exact fields and current record
          versions. Scores and source history are preserved.
        </p>
        <a
          className="text-link"
          href={chatGPTSignOutPath("/signed-out")}
          target="_top"
        >
          Sign out
        </a>
      </section>
    </div>
  );
}
