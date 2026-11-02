"use client";
import { useRef, useState } from "react";
import { Trash2 } from "lucide-react";
import type { Idea } from "@/lib/ideas/domain";
import { ApiFailure, requestData } from "./use-resource";

export function DeleteIdea({
  idea,
  onDeleted,
}: {
  idea: Idea;
  onDeleted: (id: string) => void;
}) {
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const [message, setMessage] = useState("");
  async function remove() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    let committing = false;
    try {
      if (token) {
        const result = await requestData<{ status: string }>(
          "/api/ideas/delete/status",
          { method: "POST", body: JSON.stringify({ approvalToken: token }) },
        );
        if (result.status === "done") onDeleted(idea.id);
        else if (result.status === "pending" || result.status === "failed") {
          setToken("");
          setMessage(
            "Deletion was not completed. Refresh before trying again.",
          );
        } else
          setMessage(
            "Deletion is still unconfirmed. Check status again; no deletion was resubmitted. You can also check Recent saves in Settings after reloading.",
          );
        return;
      }
      const command = { id: idea.id, expectedRevision: idea.revision };
      const approval = await requestData<{
        approvalToken: string;
        title: string;
      }>("/api/ideas/delete/prepare", {
        method: "POST",
        body: JSON.stringify(command),
      });
      if (
        !window.confirm(
          `Delete “${approval.title || "Untitled record"}”?\n\nThis moves the idea to Notion’s trash and removes it from Idea Lab. You can restore it in Notion. Linked sources, evaluations and other ideas are kept.`,
        )
      )
        return;
      setToken(approval.approvalToken);
      committing = true;
      await requestData("/api/ideas/delete/commit", {
        method: "POST",
        body: JSON.stringify({
          command,
          approvalToken: approval.approvalToken,
        }),
      });
      onDeleted(idea.id);
    } catch (error) {
      const uncertain =
        committing && (!(error instanceof ApiFailure) || error.uncertain);
      if (!uncertain && committing) setToken("");
      setMessage(
        uncertain
          ? "Deletion could not be confirmed. Check status before trying again. After a reload, use Recent saves in Settings."
          : error instanceof Error
            ? error.message
            : "Deletion could not be completed.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="idea-delete-action">
      <button
        type="button"
        className="site-secondary idea-delete-button"
        disabled={busy}
        onClick={remove}
        aria-label={
          token ? `Check deletion of ${idea.title}` : `Delete ${idea.title}`
        }
      >
        <Trash2 size={14} />
        {busy ? "Working…" : token ? "Check deletion status" : "Delete"}
      </button>
      {message && (
        <p role="status" className="subtle-note">
          {message}
        </p>
      )}
    </div>
  );
}
