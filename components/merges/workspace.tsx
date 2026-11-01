"use client";
import Link from "@/components/navigation-link";
import { useState, useEffect, useRef } from "react";
import { type Idea } from "@/lib/ideas/domain";
import { mergeCommandSchema, type MergeCommand } from "@/lib/merges/model";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
};
export function MergeWorkspace() {
  const list = useResource<Idea[]>("/api/ideas");
  const [survivor, setSurvivor] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [reason, setReason] = useState(""),
    [preserve, setPreserve] = useState(false),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [command, setCommand] = useState<MergeCommand | null>(null),
    [uncertain, setUncertain] = useState(false),
    [saved, setSaved] = useState("");
  const running = useRef(false);
  useEffect(() => setReady(true), []);
  const ideas = (list.data ?? []).filter((i) => !i.canonicalIdeaId),
    surviving = ideas.find((i) => i.id === survivor);
  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    const candidateIdeas = selected.map((id) => ideas.find((i) => i.id === id));
    const parsed = mergeCommandSchema.safeParse({
      survivorId: survivor,
      survivorRevision: surviving?.revision,
      candidates: candidateIdeas.map((i) => ({
        id: i?.id,
        revision: i?.revision,
      })),
      reason,
      preserveOriginals: preserve,
    });
    if (!parsed.success) {
      setError(
        "Choose a survivor, one to five other ideas, a reason and the preservation acknowledgment.",
      );
      return;
    }
    running.current = true;
    setBusy(true);
    setError("");
    try {
      setReceipt(
        await requestData<Receipt>("/api/merges/prepare", {
          method: "POST",
          body: JSON.stringify(parsed.data),
        }),
      );
      setCommand(parsed.data);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The merge could not be prepared.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function act(check = false) {
    if (running.current || !receipt || !command) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      if (check) {
        const result = await requestData<{
          status: string;
          ideaId?: string;
          canResume?: boolean;
        }>("/api/merges/status", {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        });
        if (result.status === "done") {
          setSaved(result.ideaId ?? command.survivorId);
          setUncertain(false);
        } else
          setError(
            result.canResume
              ? "The merge is partly saved. Open Recent Saves to explicitly resume the approved unfinished steps."
              : "The merge is still unconfirmed. No changes were replayed. Check Recent Saves or inspect Notion.",
          );
      } else {
        setUncertain(true);
        const result = await requestData<{ ideaId: string }>(
          "/api/merges/commit",
          {
            method: "POST",
            body: JSON.stringify({
              command,
              approvalToken: receipt.approvalToken,
            }),
          },
        );
        setSaved(result.ideaId);
        setUncertain(false);
      }
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The merge save could not be confirmed.",
      );
      if (
        e instanceof ApiFailure &&
        !e.uncertain &&
        e.status < 500 &&
        e.code !== "RECONCILIATION_REQUIRED"
      )
        setUncertain(false);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="page import-page">
      <div className="page-heading">
        <div>
          <div className="eyebrow">ONE IDEA, ALL ITS HISTORY</div>
          <h1>
            Bring ideas together<span>.</span>
          </h1>
          <p>Choose the survivor. Review every change. Keep every original.</p>
        </div>
      </div>
      <Link className="text-link" href="/review">
        Back to review center
      </Link>
      {list.error ? (
        <Failure error={list.error} retry={list.refresh} />
      ) : !list.data ? (
        <Loading />
      ) : saved ? (
        <section className="panel prose-panel" role="status">
          <h2>Merge confirmed.</h2>
          <p>
            The surviving idea links to preserved originals. Their source
            references and evaluations remain available in its combined history.
          </p>
          <Link className="site-primary" href={"/ideas/" + saved}>
            Open surviving idea
          </Link>
        </section>
      ) : ideas.length < 2 ? (
        <section className="panel empty-state">
          <h2>A merge needs at least two saved ideas.</h2>
          <p>Only current canonical ideas can participate.</p>
        </section>
      ) : (
        <>
          <form className="panel prose-panel" method="post" onSubmit={prepare}>
            <fieldset
              className="import-ready"
              disabled={!ready || busy || !!receipt || uncertain}
            >
              <label>
                Surviving idea
                <select
                  value={survivor}
                  onChange={(e) => {
                    setSurvivor(e.target.value);
                    setSelected((ids) =>
                      ids.filter((id) => id !== e.target.value),
                    );
                  }}
                >
                  <option value="">
                    Choose the record to keep as canonical
                  </option>
                  {ideas.map((i) => (
                    <option key={i.id} value={i.id}>
                      {i.title || "Untitled idea"}
                    </option>
                  ))}
                </select>
              </label>
              <h2>Preserve these ideas as originals</h2>
              <p>
                Choose up to five. They will be archived and linked to the
                survivor.
              </p>
              {ideas
                .filter((i) => i.id !== survivor)
                .map((i) => (
                  <label className="turn-select" key={i.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(i.id)}
                      disabled={
                        !selected.includes(i.id) && selected.length >= 5
                      }
                      onChange={(e) =>
                        setSelected((ids) =>
                          e.target.checked
                            ? [...ids, i.id]
                            : ids.filter((id) => id !== i.id),
                        )
                      }
                    />
                    <span>
                      {i.title || "Untitled idea"} · {i.status}
                    </span>
                  </label>
                ))}
              {surviving && (
                <p className="subtle-note">
                  Survivor keeps its description and current score:{" "}
                  {surviving.priorityScore ?? "Unrated"}. Original assessments
                  stay on their original records.
                </p>
              )}
              <label>
                Merge reason
                <textarea
                  rows={4}
                  maxLength={4000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <label className="turn-select">
                <input
                  type="checkbox"
                  checked={preserve}
                  onChange={(e) => setPreserve(e.target.checked)}
                />
                Keep every original description, source reference and
                evaluation. Archive candidates and direct future edits to the
                survivor.
              </label>
              <button className="site-secondary" type="submit">
                Review merge changes
              </button>
            </fieldset>
          </form>
          {receipt && (
            <section className="panel prose-panel approval-panel">
              <h2>Review the merge</h2>
              <dl className="change-list">
                {receipt.changes.map((c, n) => (
                  <div key={n}>
                    <dt>{c.field}</dt>
                    <dd>
                      {c.before && <del>{c.before}</del>}
                      <span>{c.after}</span>
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Approval expires at{" "}
                {new Date(receipt.expiresAt).toLocaleTimeString()}. Every input
                version will be checked again.
              </p>
              <button
                className="site-primary"
                disabled={busy}
                onClick={() => act(uncertain)}
              >
                {busy
                  ? "Checking…"
                  : uncertain
                    ? "Check merge save"
                    : "Approve merge into " +
                      (surviving?.title ?? "selected survivor")}
              </button>
              {!uncertain && (
                <button
                  className="site-secondary mt-button"
                  disabled={busy}
                  onClick={() => {
                    setReceipt(null);
                    setCommand(null);
                    setError("");
                  }}
                >
                  Back to merge editing
                </button>
              )}
              <Link className="text-link" href="/settings">
                Open Recent Saves
              </Link>
            </section>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
