"use client";
import { useEffect, useRef, useState } from "react";
import { Save, CheckCircle2, RefreshCw, X, ExternalLink } from "lucide-react";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import type { Idea } from "@/lib/ideas/domain";
import {
  resultSchema,
  dimensions,
  labels,
  provisionalScore,
  type RoundtableResult,
} from "@/lib/roundtable/model";
import type { SavedReport } from "@/lib/roundtable/reports";
type Approval = {
  approvalToken: string;
  expiresAt: string;
  result: RoundtableResult;
};
export function SavedReports({
  idea,
  result,
  busy,
  onLoad,
  onBusyChange,
}: {
  idea: Idea;
  result: RoundtableResult | null;
  busy: boolean;
  onLoad: (result: RoundtableResult) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const history = useResource<SavedReport[]>(
    "/api/roundtable/reports?ideaId=" + idea.id,
  );
  const [approval, setApproval] = useState<Approval | null>(null),
    [confirmed, setConfirmed] = useState<SavedReport | null>(null),
    [working, setWorking] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    onBusyChange(working || !!approval || uncertain);
  }, [working, approval, uncertain, onBusyChange]);
  const guard = useRef(false),
    load = useRef(onLoad);
  load.current = onLoad;
  const saved = result
    ? confirmed?.snapshot.result.runId === result.runId
      ? confirmed
      : history.data?.find((row) => row.snapshot.result.runId === result.runId)
    : null;
  const stale = !!result && result.input.inputRevision !== idea.revision;
  useEffect(() => {
    if (!result && !busy && history.data?.length) {
      const current =
        history.data.find(
          (row) => row.snapshot.result.input.inputRevision === idea.revision,
        ) ?? history.data[0];
      load.current(resultSchema.parse(current.snapshot.result));
    }
  }, [history.data, result, busy, idea.revision]);
  async function review() {
    if (!result || guard.current || busy) return;
    guard.current = true;
    setWorking(true);
    setError("");
    try {
      const response = await requestData<Approval | { report: SavedReport }>(
        "/api/roundtable/reports/prepare",
        { method: "POST", body: JSON.stringify(result) },
      );
      if ("report" in response) {
        setConfirmed(response.report);
        history.refresh();
      } else setApproval(response);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The report could not be reviewed for saving.",
      );
    } finally {
      guard.current = false;
      setWorking(false);
    }
  }
  async function save() {
    if (!approval || guard.current) return;
    guard.current = true;
    setWorking(true);
    setError("");
    try {
      const response = await requestData<{ report: SavedReport }>(
        "/api/roundtable/reports/commit",
        {
          method: "POST",
          body: JSON.stringify({
            result: approval.result,
            approvalToken: approval.approvalToken,
          }),
        },
      );
      setConfirmed(response.report);
      setApproval(null);
      setUncertain(false);
      history.refresh();
    } catch (e) {
      const unknown =
        !(e instanceof ApiFailure) ||
        e.uncertain ||
        e.code === "RECONCILIATION_REQUIRED";
      setUncertain(unknown);
      if (!unknown) setApproval(null);
      setError(
        e instanceof Error
          ? e.message
          : "Notion did not confirm this save. Check status.",
      );
    } finally {
      guard.current = false;
      setWorking(false);
    }
  }
  async function check() {
    if (!approval || guard.current) return;
    guard.current = true;
    setWorking(true);
    setError("");
    try {
      const response = await requestData<{
        status: string;
        report: SavedReport | null;
      }>("/api/roundtable/reports/status", {
        method: "POST",
        body: JSON.stringify({ approvalToken: approval.approvalToken }),
      });
      if (response.report) {
        setConfirmed(response.report);
        setUncertain(false);
        setApproval(null);
        history.refresh();
      } else if (["failed", "pending"].includes(response.status)) {
        setUncertain(false);
        setApproval(null);
      } else
        setError(
          "This save remains unconfirmed. No write was repeated. Check Recent saves in Settings after a reload.",
        );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Save status could not be checked.",
      );
    } finally {
      guard.current = false;
      setWorking(false);
    }
  }
  return (
    <section
      className="panel rt-saved-reports"
      aria-label="Saved roundtable assessments"
    >
      <div className="rt-save-heading">
        <div>
          <h2>
            {saved ? (
              <>
                <CheckCircle2 size={18} />
                Saved to Notion
              </>
            ) : result ? (
              <>
                <Save size={18} />
                Assessment not saved yet
              </>
            ) : (
              "Saved assessments"
            )}
          </h2>
          <p>
            {saved
              ? "This report will load when you reopen this idea. Your active idea score is unchanged."
              : result
                ? "Save this report to keep its scores and evidence after leaving or refreshing the page."
                : "Saved GPT reports appear here when you reopen an idea."}
          </p>
        </div>
        {result && !saved && !approval && (
          <button
            type="button"
            className="site-primary"
            disabled={working || busy || stale}
            onClick={review}
          >
            <Save size={15} />
            {working ? "Preparing…" : "Save assessment"}
          </button>
        )}
        {saved?.url && (
          <a
            href={saved.url}
            className="text-link"
            target="_blank"
            rel="noreferrer"
          >
            Open in Notion <ExternalLink size={13} />
          </a>
        )}
      </div>
      {stale && (
        <p className="rt-save-warning">
          This report was based on an earlier version of the idea. Its scores
          are historical.
        </p>
      )}
      {history.error && (
        <div role="alert" className="rt-save-warning">
          Saved history could not be loaded: {history.error.message}{" "}
          <button type="button" className="text-link" onClick={history.refresh}>
            Retry
          </button>
        </div>
      )}
      {!history.data && !history.error && (
        <p className="rt-agent-score-note" role="status">
          Loading saved history…
        </p>
      )}
      {!!history.data?.length && (
        <label className="rt-history-picker">
          View a saved assessment
          <select
            disabled={busy || working || !!approval}
            value={
              history.data.some(
                (row) => row.snapshot.result.runId === result?.runId,
              )
                ? result!.runId
                : ""
            }
            onChange={(e) => {
              const report = history.data?.find(
                (row) => row.snapshot.result.runId === e.target.value,
              );
              if (report)
                load.current(resultSchema.parse(report.snapshot.result));
            }}
          >
            <option value="" disabled>
              Current unsaved assessment
            </option>
            {history.data.map((report) => (
              <option key={report.id} value={report.snapshot.result.runId}>
                GPT · {new Date(report.snapshot.approvedAt).toLocaleString()} ·{" "}
                {provisionalScore(report.snapshot.result.assessment) ??
                  "Unranked"}
                {report.snapshot.result.input.inputRevision !== idea.revision
                  ? " · earlier idea version"
                  : ""}
              </option>
            ))}
          </select>
        </label>
      )}
      {approval && !uncertain && (
        <div className="rt-save-review">
          <h3>Review this assessment save</h3>
          <p>
            Save the exact report below to Notion’s review database, linked to
            this idea. It includes the selected brief, scores, evidence,
            suggestions and model provenance. This does not replace the idea’s
            active score or run GPT again.
          </p>
          <div className="rt-save-score-summary">
            {dimensions.map((key) => (
              <span key={key}>
                {labels[key]}{" "}
                <strong>
                  {approval.result.assessment.ratings[key].score ?? "Unknown"}
                </strong>
              </span>
            ))}
          </div>
          <details>
            <summary>Full report being saved</summary>
            <pre>{JSON.stringify(approval.result, null, 2)}</pre>
          </details>
          <p>
            Approval expires {new Date(approval.expiresAt).toLocaleString()}.
          </p>
          <div className="action-row">
            <button
              type="button"
              className="site-secondary"
              disabled={working}
              onClick={() => setApproval(null)}
            >
              <X size={14} />
              Cancel
            </button>
            <button
              type="button"
              className="site-primary"
              disabled={working}
              onClick={save}
            >
              <Save size={14} />
              {working ? "Saving…" : "Confirm save to Notion"}
            </button>
          </div>
        </div>
      )}
      {uncertain && (
        <div className="rt-save-review">
          <p>
            Notion may already have saved this assessment. Check status instead
            of submitting it again. After a reload, use Settings → Recent saves.
          </p>
          <button
            type="button"
            className="site-secondary"
            disabled={working}
            onClick={check}
          >
            <RefreshCw size={14} />
            {working ? "Checking…" : "Check save status"}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="rt-save-warning">
          {error}
        </p>
      )}
    </section>
  );
}
