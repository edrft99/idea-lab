"use client";
import { useEffect, useRef, useState } from "react";
import { useResource, requestData } from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
import { fieldLabels, type Idea } from "@/lib/ideas/domain";
import { semanticFields } from "@/lib/intelligence/semantic-model";
import {
  snapshotPlanSchema,
  snapshotBatchSchema,
  snapshotChoiceSchema,
  type SnapshotPlan,
  type SnapshotBatch,
  type SnapshotChoice,
} from "@/lib/intelligence/snapshot-model";
type Kind = "plan" | "batch" | "activate" | "discard";
type Receipt = {
  kind: Kind;
  command: SnapshotPlan | SnapshotBatch | SnapshotChoice;
  approvalToken: string;
  expiresAt: string;
  changes: { field: string; before: string; after: string }[];
};
type SnapshotSummary = {
  id: string;
  descriptor: { deployment: string; versionLabel: string; dimensions: number };
  fields: (typeof semanticFields)[number][];
  records: { id: string; ready: boolean }[];
  total: number;
  built: number;
  invalid: number;
  complete: boolean;
  active: boolean;
  model: string | null;
  expiresAt: string;
  createdAt: string;
};
type SnapshotList = {
  snapshots: SnapshotSummary[];
  activeSnapshotId: string | null;
  activeUnavailable: boolean;
  capacity: { snapshots: number; vectors: number };
};
const approvalLabels: Record<Kind, string> = {
  plan: "Approve snapshot plan",
  batch: "Approve and send selected batch",
  activate: "Approve atomic activation",
  discard: "Approve discarding inactive snapshot",
};
export function SnapshotWorkbench({
  ideas,
  enabled,
  disabled,
  onReviewState,
  onChange,
}: {
  ideas: Idea[];
  enabled: boolean;
  disabled: boolean;
  onReviewState: (locked: boolean) => void;
  onChange: () => void;
}) {
  const resource = useResource<SnapshotList>("/api/semantic/snapshots"),
    [fields, setFields] = useState<(typeof semanticFields)[number][]>([]),
    [wholeCollection, setWholeCollection] = useState(false),
    [chosenSnapshot, setChosenSnapshot] = useState(""),
    [selected, setSelected] = useState<string[]>([]),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [busy, setBusy] = useState(""),
    [sent, setSent] = useState(false),
    [status, setStatus] = useState(""),
    [message, setMessage] = useState(""),
    [error, setError] = useState("");
  const running = useRef(false),
    epoch = useRef(0),
    controller = useRef<AbortController | null>(null),
    reviewHeading = useRef<HTMLHeadingElement | null>(null),
    locked = disabled || !!busy || !!receipt,
    terminal = ["done", "failed", "cancelled"].includes(status),
    snapshot = resource.data?.snapshots.find((s) => s.id === chosenSnapshot),
    remaining = snapshot?.records.filter((r) => !r.ready) ?? [],
    titles = new Map(ideas.map((i) => [i.id, i.title]));
  useEffect(() => {
    onReviewState(!!busy || !!receipt);
  }, [busy, receipt, onReviewState]);
  useEffect(
    () => () => {
      epoch.current++;
      controller.current?.abort();
      onReviewState(false);
    },
    [onReviewState],
  );
  useEffect(() => {
    if (receipt) reviewHeading.current?.focus();
  }, [receipt]);
  function refresh() {
    resource.refresh();
    onChange();
  }
  async function prepare(kind: Kind) {
    if (running.current || receipt || disabled) return;
    let command: Receipt["command"];
    try {
      if (kind === "plan" && !wholeCollection)
        throw new Error("Select the complete canonical collection.");
      command =
        kind === "plan"
          ? snapshotPlanSchema.parse({
              scope: "all-current-canonical-ideas",
              fields,
            })
          : kind === "batch"
            ? snapshotBatchSchema.parse({
                snapshotId: chosenSnapshot,
                ideaIds: selected,
              })
            : snapshotChoiceSchema.parse({ snapshotId: chosenSnapshot });
    } catch {
      setError(
        kind === "plan"
          ? "Explicitly include the entire canonical collection and choose description fields."
          : kind === "batch"
            ? "Select 1–20 remaining records from this snapshot."
            : "Choose a retained snapshot first.",
      );
      return;
    }
    running.current = true;
    setBusy("preparing");
    setError("");
    setMessage("");
    const current = ++epoch.current;
    try {
      const result = await requestData<Omit<Receipt, "kind">>(
        "/api/semantic/snapshots/" + kind + "/prepare",
        { method: "POST", body: JSON.stringify(command) },
      );
      if (current !== epoch.current) return;
      setReceipt({ ...result, kind });
      setSent(false);
      setStatus("pending");
    } catch (e) {
      if (current === epoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "This snapshot action could not be reviewed.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  async function send() {
    if (!receipt || running.current || sent || disabled) return;
    running.current = true;
    setBusy("sending");
    setSent(true);
    setStatus("unknown");
    setError("");
    setMessage("");
    const current = ++epoch.current,
      abort = new AbortController();
    controller.current = abort;
    try {
      const result = await requestData<{ status: string; snapshotId?: string }>(
        "/api/semantic/snapshots/" + receipt.kind + "/commit",
        {
          method: "POST",
          signal: abort.signal,
          body: JSON.stringify({
            command: receipt.command,
            approvalToken: receipt.approvalToken,
          }),
        },
      );
      if (current !== epoch.current) return;
      setStatus("done");
      if (receipt.kind === "plan" && result.snapshotId) {
        setChosenSnapshot(result.snapshotId);
        setSelected([]);
      }
      if (receipt.kind === "batch") setSelected([]);
      if (receipt.kind === "discard") {
        setChosenSnapshot("");
        setSelected([]);
      }
      setMessage(
        receipt.kind === "plan"
          ? "Complete snapshot plan saved. Select a batch and review its exact transmission next."
          : receipt.kind === "batch"
            ? "Selected vectors retained in the inactive snapshot. Search still uses its previous index."
            : receipt.kind === "activate"
              ? "Complete snapshot activated. Search now uses this verified manifest."
              : "Inactive snapshot discarded. The active index and Notion content are preserved.",
      );
      refresh();
    } catch (e) {
      if (current === epoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "No completion was confirmed. Check operation status; no request will be replayed.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy("");
        controller.current = null;
      }
    }
  }
  async function inspect(cancel = false) {
    if (
      !receipt ||
      ["checking", "cancelling", "preparing"].includes(busy) ||
      (!cancel && running.current)
    )
      return;
    const current = ++epoch.current;
    controller.current?.abort();
    controller.current = null;
    running.current = true;
    setBusy(cancel ? "cancelling" : "checking");
    setError("");
    try {
      const result = await requestData<{ status: string; message: string }>(
        cancel ? "/api/semantic/cancel" : "/api/semantic/status",
        {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        },
      );
      if (current !== epoch.current) return;
      setStatus(result.status);
      setMessage(result.message);
      if (cancel) setSent(true);
      refresh();
    } catch (e) {
      if (current === epoch.current)
        setError(
          e instanceof Error
            ? e.message
            : "The snapshot operation could not be checked. Keep this receipt and check again.",
        );
    } finally {
      if (current === epoch.current) {
        running.current = false;
        setBusy("");
      }
    }
  }
  function close() {
    if (!terminal || running.current) return;
    epoch.current++;
    setReceipt(null);
    setSent(false);
    setStatus("");
    setError("");
  }
  return (
    <section
      className="panel prose-panel mt-panel"
      aria-label="Complete snapshot rebuilds"
    >
      <div className="section-heading">
        <h2>Complete snapshot rebuilds</h2>
        <button
          className="site-secondary"
          disabled={locked || resource.loading}
          onClick={refresh}
        >
          Refresh snapshot progress
        </button>
      </div>
      <p>
        Plan the whole current canonical collection, explicitly build reviewed
        batches, then activate only a complete verified replacement. Staging
        never changes the search pointer. Notion content and scores stay
        authoritative.
      </p>
      {resource.error ? (
        <Failure error={resource.error} retry={resource.refresh} />
      ) : !resource.data ? (
        <Loading />
      ) : (
        <>
          <p className="subtle-note">
            {resource.data.activeSnapshotId
              ? "Search pointer: " + resource.data.activeSnapshotId
              : "Search currently uses the selected-record index; no full snapshot is active."}{" "}
            Up to {resource.data.capacity.snapshots} retained manifests and{" "}
            {resource.data.capacity.vectors.toLocaleString()} vectors across
            generations.
          </p>
          {resource.data.activeUnavailable && (
            <p role="alert" className="notice">
              The active manifest expired or is unavailable. Search will not
              silently use an older index. Build a complete replacement, or
              review clearing the derived cache.
            </p>
          )}
          <fieldset disabled={locked}>
            <legend>Plan a full replacement</legend>
            <label className="semantic-choice">
              <input
                type="checkbox"
                checked={wholeCollection}
                onChange={(e) => setWholeCollection(e.target.checked)}
              />
              <span>
                Include every current canonical idea in this snapshot (up to
                1,000)
              </span>
            </label>
            <div className="semantic-fields">
              {semanticFields.map((field) => (
                <label key={field}>
                  <input
                    type="checkbox"
                    checked={fields.includes(field)}
                    onChange={(e) =>
                      setFields((previous) =>
                        e.target.checked
                          ? [...previous, field]
                          : previous.filter((f) => f !== field),
                      )
                    }
                  />
                  {fieldLabels[field]}
                </label>
              ))}
            </div>
            <p className="subtle-note">
              Planning stores IDs and hashes without a model call. Nothing is
              selected by default. Each idea needs content in the chosen fields;
              include title or summary for broad coverage.
            </p>
            <button
              className="site-primary"
              disabled={
                !enabled ||
                !wholeCollection ||
                !fields.length ||
                resource.data.snapshots.length >=
                  resource.data.capacity.snapshots
              }
              onClick={() => prepare("plan")}
            >
              Review complete snapshot plan
            </button>
          </fieldset>
          <label className="form-field">
            Saved snapshot
            <select
              aria-label="Saved semantic snapshot"
              disabled={locked}
              value={chosenSnapshot}
              onChange={(e) => {
                setChosenSnapshot(e.target.value);
                setSelected([]);
                setError("");
              }}
            >
              <option value="">Choose a retained snapshot</option>
              {resource.data.snapshots.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.active ? "Active" : "Inactive"} · {s.built}/{s.total} built
                  · {s.id.slice(0, 12)}
                </option>
              ))}
            </select>
          </label>
          {snapshot && (
            <div>
              <h3>
                {snapshot.active ? "Active snapshot" : "Inactive replacement"}
              </h3>
              <p>
                {snapshot.built} of {snapshot.total} verified cached vectors ·{" "}
                {snapshot.invalid} invalid · {snapshot.descriptor.deployment} ·{" "}
                {snapshot.descriptor.versionLabel} ·{" "}
                {snapshot.descriptor.dimensions} dimensions
              </p>
              <p className="subtle-note">
                Fields: {snapshot.fields.map((f) => fieldLabels[f]).join(", ")}.
                Expires {new Date(snapshot.expiresAt).toLocaleString()}.
                Activation rechecks current canonical membership and
                descriptions; this progress count is not a current-content
                approval.
              </p>
              {!snapshot.active && (
                <>
                  <fieldset disabled={locked}>
                    <legend>
                      Choose the next batch · {selected.length} of 20
                    </legend>
                    <div className="action-row">
                      <button
                        className="site-secondary"
                        disabled={!remaining.length}
                        onClick={() =>
                          setSelected(remaining.slice(0, 20).map((r) => r.id))
                        }
                      >
                        Select next 20 remaining records
                      </button>
                      <button
                        className="site-secondary"
                        onClick={() => setSelected([])}
                      >
                        Clear batch selection
                      </button>
                    </div>
                    <div className="semantic-selection">
                      {remaining.slice(0, 100).map((r) => (
                        <label className="semantic-choice" key={r.id}>
                          <input
                            type="checkbox"
                            aria-label={
                              "Stage " +
                              (titles.get(r.id) ??
                                "unavailable current record") +
                              " · " +
                              r.id
                            }
                            checked={selected.includes(r.id)}
                            disabled={
                              !selected.includes(r.id) && selected.length >= 20
                            }
                            onChange={(e) =>
                              setSelected((previous) =>
                                e.target.checked
                                  ? [...previous, r.id]
                                  : previous.filter((id) => id !== r.id),
                              )
                            }
                          />
                          <span>
                            {titles.get(r.id) ?? "Current record unavailable"}
                            <small>{r.id}</small>
                          </span>
                        </label>
                      ))}
                    </div>
                    {remaining.length > 100 && (
                      <p className="subtle-note">
                        Showing the first 100 remaining records. Completing
                        batches reveals the next records; the full manifest
                        contains {snapshot.total} records.
                      </p>
                    )}
                    <button
                      className="site-primary"
                      disabled={!enabled || !selected.length}
                      onClick={() => prepare("batch")}
                    >
                      Review selected snapshot batch
                    </button>
                  </fieldset>
                  <div className="action-row">
                    <button
                      className="site-primary"
                      disabled={locked || !enabled || !snapshot.complete}
                      onClick={() => prepare("activate")}
                    >
                      Review complete snapshot activation
                    </button>
                    <button
                      className="site-secondary"
                      disabled={locked}
                      onClick={() => prepare("discard")}
                    >
                      Review discarding inactive snapshot
                    </button>
                  </div>
                  <p className="subtle-note">
                    Every batch is a separate model request and may incur cost.
                    There is no automatic loop, retry or snapshot activation.
                    Activation and discarding make no model call.
                  </p>
                </>
              )}
            </div>
          )}
        </>
      )}
      {receipt && (
        <section
          className="semantic-review mt-panel"
          aria-label="Snapshot action review"
        >
          <h3 ref={reviewHeading} tabIndex={-1}>
            {receipt.kind === "batch"
              ? "Review snapshot transmission"
              : "Review snapshot action"}
          </h3>
          <p>
            Approval expires {new Date(receipt.expiresAt).toLocaleTimeString()}.
            Operation: {status}.
          </p>
          {receipt.changes.map((c, i) => (
            <div className="diff-row" key={i}>
              <strong>{c.field}</strong>
              {c.before && <p className="preserve-text">{c.before}</p>}
              <p className="preserve-text">{c.after}</p>
            </div>
          ))}
          <div className="action-row">
            {!sent && (
              <button className="site-primary" disabled={!!busy} onClick={send}>
                {approvalLabels[receipt.kind]}
              </button>
            )}
            {sent && !terminal && (
              <button
                className="site-secondary"
                disabled={!!busy}
                onClick={() => inspect()}
              >
                Check snapshot operation
              </button>
            )}
            {!terminal && (
              <button
                className="site-secondary"
                disabled={!!busy && busy !== "sending"}
                onClick={() => inspect(true)}
              >
                Cancel snapshot operation
              </button>
            )}
            {terminal && (
              <button
                className="site-secondary"
                disabled={!!busy}
                onClick={close}
              >
                Continue snapshot workflow
              </button>
            )}
          </div>
          <p className="subtle-note">
            Cancellation fences later writes. A dispatched provider request may
            already incur cost; partial vectors or a completed pointer switch
            can remain. Status checks never replay model requests.
          </p>
        </section>
      )}
      {busy && (
        <p role="status">
          {busy === "preparing"
            ? "Preparing the exact snapshot review…"
            : busy === "sending"
              ? "Processing the approved snapshot action…"
              : busy === "cancelling"
                ? "Cancelling the derived operation…"
                : "Checking retained snapshot state…"}
        </p>
      )}
      {error && (
        <p role="alert" className="notice">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="notice">
          {message}
        </p>
      )}
    </section>
  );
}
