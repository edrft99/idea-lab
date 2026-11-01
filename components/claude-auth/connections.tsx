"use client";
import { useState } from "react";
import { useResource, requestData } from "@/components/ideas/use-resource";
type Session = {
  id: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  expired: boolean;
};
export function ClaudeConnections() {
  const resource = useResource<Session[]>("/api/claude/connections/sessions"),
    [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  async function revoke(id: string) {
    if (busy) return;
    setBusy(id);
    setError("");
    try {
      await requestData("/api/claude/connections/revoke", {
        method: "POST",
        body: JSON.stringify({ sessionId: id }),
      });
      resource.refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Revocation could not be confirmed.",
      );
    } finally {
      setBusy("");
    }
  }
  return (
    <section className="panel prose-panel mt-panel">
      <h2>Claude connections</h2>
      {resource.error ? (
        <p>{resource.error.message}</p>
      ) : !resource.data ? (
        <p role="status">Checking Claude connections…</p>
      ) : resource.data.length === 0 ? (
        <p>No Claude connections have been authorized.</p>
      ) : (
        resource.data.map((s) => (
          <div className="diff-row" key={s.id}>
            <strong>
              {s.revoked
                ? "Revoked Claude connection"
                : s.expired
                  ? "Expired Claude connection"
                  : "Claude connection"}
            </strong>
            <p>
              Approved {new Date(s.createdAt).toLocaleString()} · Expires{" "}
              {new Date(s.expiresAt).toLocaleString()}
            </p>
            <p>{s.scopes.join(", ")}</p>
            {!s.revoked && !s.expired && (
              <button
                className="site-secondary"
                disabled={!!busy}
                onClick={() => revoke(s.id)}
              >
                {busy === s.id ? "Revoking…" : "Revoke this connection"}
              </button>
            )}
          </div>
        ))
      )}
      {error && <p role="alert">{error}</p>}
      <p className="subtle-note">
        Revocation stops both access and refresh tokens. It preserves your
        ideas, sources and save history.
      </p>
    </section>
  );
}
