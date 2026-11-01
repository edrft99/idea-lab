"use client";
import { useState, useRef } from "react";
import { useResource, requestData } from "@/components/ideas/use-resource";
import {
  aiExtractionRequestSchema,
  aiExtractionResultSchema,
  type AIExtractionResult,
  type AIExtractionRequest,
} from "@/lib/intelligence/extraction-model";
import { sourceIdentity, type ImportSource } from "@/lib/imports/provenance";
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  command: AIExtractionRequest;
  changes: { field: string; before: string; after: string }[];
};
export function AIExtraction({
  source,
  initial,
  onResult,
}: {
  source: ImportSource;
  initial?: AIExtractionResult;
  onResult: (result: AIExtractionResult) => void;
}) {
  const profile = useResource<{ enabled: boolean }>("/api/ai/status"),
    [evidence, setEvidence] = useState(source.evidence),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [result, setResult] = useState<AIExtractionResult | null>(initial ?? null),
    [busy, setBusy] = useState(false),
    [uncertain, setUncertain] = useState(false),
    [terminal, setTerminal] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const running = useRef(false),
    file = useRef<HTMLInputElement>(null);
  async function prepare(e: React.FormEvent) {
    e.preventDefault();
    if (running.current) return;
    setError("");
    setMessage("");
    const parsed = aiExtractionRequestSchema.safeParse({
      source: { ...source, evidence },
    });
    if (!parsed.success) {
      setError("Choose a selected excerpt of 1–6,000 characters.");
      return;
    }
    running.current = true;
    setBusy(true);
    try {
      setReceipt(
        await requestData<Receipt>("/api/ai/extractions/prepare", {
          method: "POST",
          body: JSON.stringify(parsed.data),
        }),
      );
      setTerminal(false);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "The AI extraction review could not be prepared.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (!receipt || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    setUncertain(true);
    try {
      const response = await requestData<{ result: AIExtractionResult }>(
        "/api/ai/extractions/commit",
        {
          method: "POST",
          body: JSON.stringify({
            command: receipt.command,
            approvalToken: receipt.approvalToken,
          }),
        },
      );
      const value = aiExtractionResultSchema.parse(response.result);
      setResult(value);
      setReceipt(null);
      setUncertain(false);
      onResult(value);
      setMessage(
        "AI result kept locally. No canonical idea or Notion proposal was created.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "No AI extraction was confirmed. Check request status before another request.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  async function check() {
    if (!receipt || running.current) return;
    running.current = true;
    setBusy(true);
    setError("");
    try {
      const state = await requestData<{ status: string; message: string }>(
        "/api/ai/extractions/status",
        {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        },
      );
      setMessage(state.message);
      setTerminal(["done", "failed", "pending"].includes(state.status));
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The AI request could not be checked.",
      );
    } finally {
      running.current = false;
      setBusy(false);
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(result, null, 2)], {
          type: "application/json",
        }),
      ),
      a = document.createElement("a");
    a.href = url;
    a.download = "idea-lab-ai-extraction.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore(selected?: File) {
    if (!selected || busy || receipt) return;
    setError("");
    try {
      if (selected.size > 512000) throw new Error("Too large");
      const value = aiExtractionResultSchema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            await selected.arrayBuffer(),
          ),
        ),
      );
      if (
        JSON.stringify(sourceIdentity(value.input.source)) !==
        JSON.stringify(sourceIdentity(source))
      )
        throw new Error("Different source");
      setResult(value);
      setEvidence(value.input.source.evidence);
      onResult(value);
      setMessage(
        "Private result restored locally. Server proof and current Notion revisions are checked before storage.",
      );
    } catch {
      setError(
        "Choose a valid private extraction result for this same source, smaller than 512 KB.",
      );
    } finally {
      if (file.current) file.current.value = "";
    }
  }
  return (
    <section className="panel prose-panel">
      <h2>Ask AI about this selected excerpt</h2>
      <p>
        AI can suggest an idea or flag routine/uncertain content. It cannot
        search your collection, approve a capture, set scores or merge records.
      </p>
      {profile.data?.enabled ? (
        <form method="post" onSubmit={prepare}>
          <fieldset className="import-ready" disabled={busy || !!receipt}>
            <label>
              AI extraction excerpt
              <textarea
                aria-label="AI extraction excerpt"
                rows={5}
                maxLength={6000}
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
              />
            </label>
            <p>
              Only this excerpt and its user/assistant/document role will be
              sent. Source IDs, URLs, dates and other turns stay out of the
              model request.
            </p>
            <button className="site-secondary" type="submit">
              Review AI extraction transmission
            </button>
          </fieldset>
        </form>
      ) : (
        <p>
          AI extraction is unavailable until a compatible model deployment, key
          and retention policy are configured. Local drafts still work.
        </p>
      )}
      {receipt && (
        <section className="approval-panel mt-panel">
          <h3>Review this extraction request</h3>
          <dl className="change-list">
            {receipt.changes.map((c) => (
              <div key={c.field}>
                <dt>{c.field}</dt>
                <dd>
                  <span className="preserve-text">{c.after}</span>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            Consent expires at{" "}
            {new Date(receipt.expiresAt).toLocaleTimeString()}.
          </p>
          {uncertain ? (
            <>
              <button
                className="site-secondary"
                disabled={busy}
                onClick={check}
              >
                Check AI extraction request
              </button>
              {terminal && (
                <button
                  className="site-secondary mt-button"
                  disabled={busy}
                  onClick={() => {
                    setReceipt(null);
                    setUncertain(false);
                    setTerminal(false);
                    setMessage(
                      "A new transmission requires a new review and may incur another provider charge.",
                    );
                  }}
                >
                  Review a new extraction request
                </button>
              )}
            </>
          ) : (
            <>
              <button className="site-primary" disabled={busy} onClick={send}>
                Send selected excerpt for AI extraction
              </button>
              <button
                className="site-secondary mt-button"
                disabled={busy}
                onClick={() => setReceipt(null)}
              >
                Back to excerpt editing
              </button>
            </>
          )}
        </section>
      )}
      {result && (
        <section className="notice mt-panel">
          <h3>AI suggestion: {result.classification}</h3>
          <p className="preserve-text">{result.rationale}</p>
          <p>
            {Math.round(result.confidence * 100)}% confidence ·{" "}
            {result.resolvedModel} · prompt {result.promptVersion}
          </p>
          <p>
            {result.data
              ? "The editable draft below now contains the extracted candidate."
              : "No candidate was extracted. Your existing local draft is retained."}{" "}
            AI provenance is preserved. Saving requires a separate proposal
            review; Routine/Uncertain overrides require your reason.
          </p>
          <button className="site-secondary" onClick={download}>
            Download private extraction result
          </button>
        </section>
      )}
      {!receipt && (
        <>
          <button
            className="site-secondary mt-button"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            Load private extraction result
          </button>
          <input
            ref={file}
            hidden
            type="file"
            accept=".json,application/json"
            aria-label="Private extraction result file"
            onChange={(e) => void restore(e.target.files?.[0])}
          />
        </>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function ExtractionOrigin({
  result,
  overrideReason,
}: {
  result: AIExtractionResult;
  overrideReason?: string;
}) {
  return (
    <section className="panel prose-panel">
      <h2>Preserved AI extraction</h2>
      <p>
        {result.classification} · {Math.round(result.confidence * 100)}%
        confidence · {result.resolvedModel} · prompt {result.promptVersion}
      </p>
      <p className="preserve-text">{result.rationale}</p>
      {overrideReason && (
        <p className="preserve-text">
          Human classification override: {overrideReason}
        </p>
      )}
      <p className="subtle-note">
        The original AI suggestion remains preserved separately from your
        reviewed edits.
      </p>
      {result.data && (
        <p className="preserve-text">
          {result.data.title}: {result.data.summary}
        </p>
      )}
    </section>
  );
}
