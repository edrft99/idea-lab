"use client";
import { useRef, useState } from "react";
import { useResource, requestData } from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
type Review = {
  requestId: string;
  clientName: string;
  clientId: string;
  redirectUri: string;
  resource: string;
  scopes: string[];
  expiresAt: string;
  status: string;
  canApprove: boolean;
  reviewHash: string;
};
export function ClaudeConsent({ id }: { id: string }) {
  const resource = useResource<Review>("/api/claude/connections/" + id),
    [checked, setChecked] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [sent, setSent] = useState(false),
    running = useRef(false),
    view = resource.data;
  async function decide(decision: "approve" | "deny") {
    if (
      !view ||
      running.current ||
      sent ||
      (decision === "approve" && !checked)
    )
      return;
    running.current = true;
    setBusy(true);
    setError("");
    setSent(true);
    try {
      const result = await requestData<{ redirectUrl: string }>(
        "/api/claude/connections/decide",
        {
          method: "POST",
          body: JSON.stringify({
            requestId: id,
            decision,
            reviewHash: view.reviewHash,
          }),
        },
      );
      const target = new URL(result.redirectUrl);
      if (
        target.origin !== "https://claude.ai" ||
        target.pathname !== "/api/mcp/auth_callback"
      )
        throw new Error(
          "The connection returned an unexpected callback. Nothing was redirected.",
        );
      window.location.assign(target.href);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "This connection could not be confirmed. Start again from Claude.",
      );
    } finally {
      setBusy(false);
      running.current = false;
    }
  }
  return (
    <div className="page narrow-page import-page claude-consent">
      <div className="page-heading">
        <div>
          <div className="eyebrow">CONNECT YOUR ASSISTANT</div>
          <h1>
            Let Claude use your Idea Lab<span>.</span>
          </h1>
          <p>
            Approve only a connection you just started in your own Claude
            account.
          </p>
        </div>
      </div>
      {resource.error ? (
        <Failure error={resource.error} retry={resource.refresh} />
      ) : !view ? (
        <Loading />
      ) : (
        <section className="panel prose-panel">
          <h2>{view.clientName} requests access</h2>
          <p>
            This grants Claude access to your private idea workspace. It does
            not save an idea or approve a merge.
          </p>
          <dl className="change-list">
            <div>
              <dt>Application</dt>
              <dd>{view.clientId}</dd>
            </div>
            <div>
              <dt>Resource</dt>
              <dd>{view.resource}</dd>
            </div>
            <div>
              <dt>Requested access</dt>
              <dd>
                <ul>
                  {view.scopes.includes("ideas:read") && (
                    <li>
                      Search and read your Notion ideas and source metadata.
                    </li>
                  )}
                  {view.scopes.includes("ideas:capture") && (
                    <li>
                      Stage selected idea drafts and updates for your separate
                      website review; check the status of approved saves.
                    </li>
                  )}
                </ul>
              </dd>
            </div>
            <div>
              <dt>Connection duration</dt>
              <dd>
                Up to 30 days, with short-lived access tokens. You can revoke it
                earlier in Settings.
              </dd>
            </div>
            <div>
              <dt>Consent review expires</dt>
              <dd>{new Date(view.expiresAt).toLocaleString()}</dd>
            </div>
          </dl>
          <p>
            Idea saves still require exact human review. Claude receives scoped
            access tokens; it receives no Notion integration key or Site service
            credential.
          </p>
          {view.canApprove ? (
            <>
              <label className="semantic-choice">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={busy || sent}
                  aria-label="I started this Claude connection and approve the listed access"
                  onChange={(e) => setChecked(e.target.checked)}
                />
                <span>
                  I started this Claude connection and approve the listed
                  access.
                </span>
              </label>
              <div className="action-row">
                <button
                  className="site-primary"
                  disabled={!checked || busy || sent}
                  onClick={() => decide("approve")}
                >
                  {busy ? "Completing connection…" : "Allow Claude access"}
                </button>
                <button
                  className="site-secondary"
                  disabled={busy || sent}
                  onClick={() => decide("deny")}
                >
                  Deny access
                </button>
              </div>
            </>
          ) : (
            <p role="status">
              This request is{" "}
              {view.status === "pending" ? "expired" : view.status}. Start a new
              connection from Claude.
            </p>
          )}
          {sent && !busy && error && (
            <p>
              Do not resubmit this consent. Start a fresh connection from Claude
              if the result is uncertain.
            </p>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
    </div>
  );
}
