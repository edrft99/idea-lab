"use client";
import Link from "@/components/navigation-link";
import { RefreshCw, Link2 } from "lucide-react";
import type { ApiFailure } from "./use-resource";
export function Loading() {
  return (
    <div className="panel empty-state" role="status">
      <RefreshCw size={24} />
      <h2>Opening your collection…</h2>
      <p>Reading canonical records from Notion.</p>
    </div>
  );
}
export function Failure({
  error,
  retry,
  stale = false,
}: {
  error: ApiFailure;
  retry: () => void;
  stale?: boolean;
}) {
  const config = [
    "NOTION_TOKEN_REQUIRED",
    "NOTION_CONFIGURATION_REQUIRED",
    "OWNER_CONFIGURATION_REQUIRED",
    "WRITE_COORDINATOR_REQUIRED",
  ].includes(error.code);
  return (
    <div className="panel empty-state" role="alert">
      <Link2 size={26} />
      <h2>
        {config
          ? "One connection to finish."
          : error.status === 404
            ? "This idea could not be found."
            : "The lab needs a moment."}
      </h2>
      <p>{error.message}</p>
      {stale && (
        <p>Previously loaded records are hidden until refresh succeeds.</p>
      )}
      <div className="action-row">
        <button className="site-secondary" onClick={retry}>
          <RefreshCw size={14} />
          Try again
        </button>
        <Link className="site-primary" href="/settings">
          Connection settings
        </Link>
      </div>
    </div>
  );
}
