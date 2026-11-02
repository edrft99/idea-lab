"use client";
import Link from "@/components/navigation-link";
import { useResource } from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
export function RoundtableConfiguration() {
  const r = useResource<{
    gpt: {
      enabled: boolean;
      message?: string;
      profile?: {
        deployment: string;
        provider: string;
        retentionNotice: string;
      };
    };
  }>("/api/roundtable/status");
  return (
    <section className="panel prose-panel mt-panel">
      <h2>Roundtable · GPT connection</h2>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.gpt.enabled ? (
        <>
          <p>Configured model: {r.data.gpt.profile?.deployment}</p>
          <p>{r.data.gpt.profile?.retentionNotice}</p>
          <p>
            Each request requires review of the selected idea brief. Completed
            reports save automatically to Notion; the idea’s active score stays
            unchanged.
          </p>
        </>
      ) : (
        <>
          <p>{r.data.gpt.message}</p>
          <details>
            <summary>Connection setup</summary>
            <p>
              For direct OpenAI access, configure these protected Site runtime
              settings:
            </p>
            <ul>
              <li>
                <code>IDEA_LAB_GPT_PROVIDER=openai-responses</code>
              </li>
              <li>
                <code>IDEA_LAB_GPT_MODEL</code>: an available model supporting
                Responses structured outputs
              </li>
              <li>
                <code>IDEA_LAB_GPT_API_KEY</code>: the model API credential
              </li>
              <li>
                <code>IDEA_LAB_GPT_RETENTION_NOTICE</code>: the service’s actual
                retention policy
              </li>
            </ul>
            <p>
              For the existing Azure route, set{" "}
              <code>IDEA_LAB_GPT_PROVIDER=azure-openai-responses</code> and
              configure the existing Azure AI settings. API credentials stay on
              the server. Do not paste them into an idea or chat.
            </p>
          </details>
        </>
      )}
      <Link className="text-link" href="/roundtable">
        Open the roundtable →
      </Link>
      <ClaudeConfiguration />
      <p>
        Grok and GitHub Copilot are next. Peer discussion remains a future
        stage.
      </p>
    </section>
  );
}

function ClaudeConfiguration() {
  const r = useResource<{
    claude: {
      enabled: boolean;
      message?: string;
      profile?: { deployment: string; retentionNotice: string };
    };
  }>("/api/roundtable/status");
  return (
    <div className="mt-panel">
      <h2>Roundtable · Claude connection</h2>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.claude.enabled ? (
        <>
          <p>Configured model: {r.data.claude.profile?.deployment}</p>
          <p>{r.data.claude.profile?.retentionNotice}</p>
        </>
      ) : (
        <>
          <p>{r.data.claude.message}</p>
          <details>
            <summary>Claude connection setup</summary>
            <p>Add these protected Site runtime settings:</p>
            <ul>
              <li>
                <code>IDEA_LAB_CLAUDE_MODEL</code>: an Anthropic model
                supporting JSON schema structured outputs
              </li>
              <li>
                <code>IDEA_LAB_CLAUDE_API_KEY</code>: your Anthropic API
                credential
              </li>
              <li>
                <code>IDEA_LAB_CLAUDE_RETENTION_NOTICE</code>: the retention
                terms for your Anthropic API account
              </li>
            </ul>
            <p>
              The Claude app relay and Claude subscription do not provide this
              API credential. Keep keys in protected settings.
            </p>
          </details>
        </>
      )}
      <p>
        Select Claude to reuse GPT’s assessed brief and the same scoring rubric.
        Each reviewer has separate scores and automatically saved history.
      </p>
    </div>
  );
}
