"use client";
import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  RefreshCw,
  ExternalLink,
  LoaderCircle,
} from "lucide-react";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import type { Idea } from "@/lib/ideas/domain";
import {
  reviewerName,
  type ActiveReviewer,
  resultSchema,
  provisionalScore,
  type RoundtableResult,
} from "@/lib/roundtable/model";
import type { SavedReport, AutoSaveResult } from "@/lib/roundtable/reports";
export function SavedReports({
  idea,
  participant,
  result,
  busy,
  storage,
  onLoad,
  onHistory,
  onBusyChange,
}: {
  idea: Idea;
  participant: ActiveReviewer;
  result: RoundtableResult | null;
  busy: boolean;
  storage: AutoSaveResult | null;
  onLoad: (result: RoundtableResult) => void;
  onHistory: (reports: SavedReport[]) => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const history = useResource<SavedReport[]>(
    "/api/roundtable/reports?ideaId=" + idea.id,
  );
  const reports = history.data?.filter(
    (row) => row.snapshot.result.participant === participant,
  );
  const name = reviewerName(participant);
  const [local, setLocal] = useState<{
      runId: string;
      state: AutoSaveResult;
    } | null>(null),
    [working, setWorking] = useState(false),
    [error, setError] = useState("");
  const guard = useRef(false),
    attempted = useRef(new Set<string>()),
    load = useRef(onLoad);
  load.current = onLoad;
  const historyCallback = useRef(onHistory);
  historyCallback.current = onHistory;
  useEffect(() => {
    if (history.data) historyCallback.current(history.data);
  }, [history.data]);
  const state = local?.runId === result?.runId ? local?.state : storage;
  const saved = result
    ? state?.status === "saved" &&
      state.report.snapshot.result.runId === result.runId
      ? state.report
      : reports?.find((row) => row.snapshot.result.runId === result.runId)
    : null;
  const stale = !!result && result.input.inputRevision !== idea.revision;
  useEffect(() => {
    onBusyChange(working);
  }, [working, onBusyChange]);
  useEffect(() => {
    if (!result && !busy && reports?.length) {
      const current =
        reports.find(
          (row) => row.snapshot.result.input.inputRevision === idea.revision,
        ) ?? reports[0];
      load.current(resultSchema.parse(current.snapshot.result));
    }
  }, [history.data, result, busy, idea.revision, participant]);
  async function persist() {
    if (!result || guard.current || busy) return;
    guard.current = true;
    attempted.current.add(result.runId);
    setWorking(true);
    setError("");
    const current = result;
    try {
      const response = await requestData<AutoSaveResult>(
        "/api/roundtable/reports/auto-save",
        { method: "POST", body: JSON.stringify(current) },
      );
      setLocal({ runId: current.runId, state: response });
      if (response.status === "saved") history.refresh();
    } catch (e) {
      setLocal({
        runId: current.runId,
        state: {
          status:
            !(e instanceof ApiFailure) || e.uncertain ? "uncertain" : "failed",
          operationId: null,
          message:
            e instanceof Error
              ? e.message
              : "Automatic saving could not be confirmed.",
        },
      });
    } finally {
      guard.current = false;
      setWorking(false);
    }
  }
  useEffect(() => {
    if (
      result &&
      !busy &&
      !saved &&
      !state &&
      (history.data || history.error) &&
      !attempted.current.has(result.runId)
    )
      void persist();
  }, [result, busy, saved, state, history.data, history.error]);
  async function check() {
    if (!result || guard.current) return;
    guard.current = true;
    setWorking(true);
    setError("");
    const current = result;
    try {
      const response = await requestData<{
        status: string;
        report: SavedReport | null;
      }>("/api/roundtable/reports/status", {
        method: "POST",
        body: JSON.stringify(
          state?.status !== "saved" && state?.operationId
            ? { operationId: state.operationId }
            : { result: current },
        ),
      });
      if (response.report) {
        setLocal({
          runId: current.runId,
          state: { status: "saved", report: response.report },
        });
        history.refresh();
      } else if (["failed", "pending"].includes(response.status)) {
        setLocal({
          runId: current.runId,
          state: {
            status: "failed",
            operationId: null,
            message:
              "This save was not completed. Retry automatic saving; The model will not run again.",
          },
        });
      } else
        setError(
          "Saving is still unconfirmed. No write was repeated. Check Recent saves in Settings after a reload.",
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
  const pending = !!result && !saved && (!state || working);
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
            ) : pending ? (
              <>
                <LoaderCircle size={18} className="rt-spin" />
                Saving assessment…
              </>
            ) : result ? (
              "Automatic save needs attention"
            ) : (
              "Saved assessments"
            )}
          </h2>
          <p>
            {saved
              ? "Automatically saved. This report will load when you reopen the idea; your active idea score is unchanged."
              : pending
                ? "Keeping this assessment’s scores, evidence and brief in Notion. No extra approval is needed."
                : result
                  ? "The reviewer completed, but its report is not confirmed saved. Retry or check storage only; The model will not run again."
                  : "Completed assessments save automatically and appear here when you reopen an idea."}
          </p>
        </div>
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
      {result && !saved && state && state.status !== "saved" && !working && (
        <div className="rt-save-warning">
          <p>{state.message}</p>
          <button
            type="button"
            className="site-secondary"
            disabled={busy}
            onClick={state.status === "uncertain" ? check : persist}
          >
            <RefreshCw size={14} />
            {state.status === "uncertain"
              ? "Check save status"
              : "Retry automatic save"}
          </button>
        </div>
      )}
      {!result && reports?.length === 0 && (
        <p className="rt-agent-score-note">
          No saved {name} assessment for this idea yet.{" "}
          {participant !== "gpt"
            ? `Reuse the assessed brief below to request ${name}’s independent review.`
            : "Prepare a brief below to start a review."}
        </p>
      )}
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
            Retry history
          </button>
        </div>
      )}
      {!history.data && !history.error && (
        <p className="rt-agent-score-note" role="status">
          Loading saved history…
        </p>
      )}
      {!!reports?.length && (
        <label className="rt-history-picker">
          View a saved assessment
          <select
            disabled={busy || working}
            value={
              reports.some((row) => row.snapshot.result.runId === result?.runId)
                ? result!.runId
                : ""
            }
            onChange={(e) => {
              const report = reports?.find(
                (row) => row.snapshot.result.runId === e.target.value,
              );
              if (report)
                load.current(resultSchema.parse(report.snapshot.result));
            }}
          >
            <option value="" disabled>
              Current assessment
            </option>
            {reports.map((report) => (
              <option key={report.id} value={report.snapshot.result.runId}>
                {name} · {new Date(report.snapshot.approvedAt).toLocaleString()}{" "}
                ·{" "}
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
      {error && (
        <p role="alert" className="rt-save-warning">
          {error}
        </p>
      )}
    </section>
  );
}
