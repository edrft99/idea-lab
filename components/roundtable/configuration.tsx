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
      <AdditionalConfiguration reviewer="claude" />
      <AdditionalConfiguration reviewer="grok" />
      <p>GitHub Copilot is next. Peer discussion remains a future stage.</p>
    </section>
  );
}

function AdditionalConfiguration({
  reviewer,
}: {
  reviewer: "claude" | "grok";
}) {
  const name = reviewer === "grok" ? "Grok" : "Claude";
  const vendor = reviewer === "grok" ? "xAI" : "Anthropic";
  const prefix = "IDEA_LAB_" + reviewer.toUpperCase();
  const r = useResource<{
    [key: string]: {
      enabled: boolean;
      message?: string;
      profile?: { deployment: string; retentionNotice: string };
    };
  }>("/api/roundtable/status");
  return (
    <div className="mt-panel">
      <h2>Roundtable · {name} connection</h2>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data[reviewer].enabled ? (
        <>
          <p>Configured model: {r.data[reviewer].profile?.deployment}</p>
          <p>{r.data[reviewer].profile?.retentionNotice}</p>
        </>
      ) : (
        <>
          <p>{r.data[reviewer].message}</p>
          <details>
            <summary>{name} connection setup</summary>
            <p>Add these protected Site runtime settings:</p>
            <ul>
              <li>
                <code>{prefix}_MODEL</code>: a {vendor} model supporting JSON
                schema structured outputs
              </li>
              <li>
                <code>{prefix}_API_KEY</code>: your {vendor} API credential
              </li>
              <li>
                <code>{prefix}_RETENTION_NOTICE</code>: the retention terms for
                your {vendor} API account
              </li>
            </ul>
            <p>
              Use a {vendor} API credential. Consumer subscriptions and the
              Claude relay do not provide this key. Keep keys in protected
              settings.
            </p>
          </details>
        </>
      )}
      <p>
        Select {name} to reuse the assessed brief and the same scoring rubric.
        Each reviewer has separate scores and automatically saved history.
      </p>
    </div>
  );
}
