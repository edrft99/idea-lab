"use client";
import { RefreshCw, Check, Link2 } from "lucide-react";
import { useResource } from "./use-resource";
export function ConnectionStatus() {
  const { data, error, loading, refresh } = useResource<{
    readsVerified: boolean;
    writeLedger: boolean;
    writesVerified: boolean;
  }>("/api/connection");
  return (
    <section className="panel prose-panel">
      <div className="section-heading">
        <h2>
          <Link2 size={17} />
          Notion connection
        </h2>
        <button className="site-secondary" onClick={refresh} disabled={loading}>
          <RefreshCw size={14} />
          Check connection
        </button>
      </div>
      {error ? (
        <>
          <p role="alert">{error.message}</p>
          <p className="subtle-note">
            For this private app, configure a scoped Notion internal-connection
            token as NOTION_TOKEN in protected runtime settings. Grant that
            connection access to the Idea Lab parent page. No token is displayed
            or accepted through this browser form.
          </p>
        </>
      ) : !data ? (
        <p role="status">Checking configured data sources…</p>
      ) : (
        <>
          <p>
            <Check size={15} /> Reads from all four configured data sources
            succeeded.
          </p>
          <p>
            {data.writeLedger
              ? "Approval ledger is available. Writes still require explicit approval."
              : "Saving is disabled until the operation ledger migration is applied."}
          </p>
          <p className="subtle-note">
            Read access does not prove insert/update capability. A user-approved
            live save must verify writing after the token is configured.
          </p>
        </>
      )}
    </section>
  );
}
