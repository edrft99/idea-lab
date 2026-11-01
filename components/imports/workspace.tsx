"use client";
import { AIExtraction } from "@/components/intelligence/extraction";
import { SaveProposal } from "@/components/proposals/workspace";
import Link from "@/components/navigation-link";
import { NotionSelector } from "./notion-selector";
import { ImportJobs } from "./jobs";
import type { ImportJobView } from "@/lib/imports/job-model";
import { DraftComparison } from "@/components/reviews/comparison";
import { useEffect, useRef, useState } from "react";
import {
  Upload,
  ShieldCheck,
  Download,
  Trash2,
  Check,
  ArrowRight,
} from "lucide-react";
import { parseImport } from "@/lib/imports/adapters";
import { redact, suggestion, makeProposal } from "@/lib/imports/staging";
import {
  MAX_FILE_BYTES,
  sourceIdentity,
  downloadCheckpoint,
  readCheckpoint,
  type ParsedImport,
  type Proposal,
} from "@/lib/imports/model";
import { IdeaEditor } from "@/components/ideas/editor";
const identity = (p: Proposal) => JSON.stringify(sourceIdentity(p.source));
export function ImportWorkspace() {
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const [format, setFormat] = useState<"chatgpt" | "claude" | "codex">(
      "chatgpt",
    ),
    [paste, setPaste] = useState(""),
    [parsed, setParsed] = useState<ParsedImport | null>(null),
    [conversationId, setConversationId] = useState(""),
    [branchId, setBranchId] = useState(""),
    [selection, setSelection] = useState<Record<string, string>>({}),
    [extra, setExtra] = useState(""),
    [query, setQuery] = useState(""),
    [page, setPage] = useState(0),
    [proposals, setProposals] = useState<Proposal[]>([]),
    [active, setActive] = useState<string | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [dirty, setDirty] = useState(false),
    [clear, setClear] = useState(false),
    [notionKey, setNotionKey] = useState(0),
    [queued, setQueued] = useState<Record<string, string>>({}),
    [trackedJobId, setTrackedJobId] = useState<string | null>(null),
    [jobView, setJobView] = useState<ImportJobView | null>(null),
    [jobRefresh, setJobRefresh] = useState(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("job");
    if (
      value &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        value,
      )
    )
      setTrackedJobId(value);
  }, []);
  const generation = useRef(0),
    fileInput = useRef<HTMLInputElement>(null),
    checkpointInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => {
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty]);
  const conversation = parsed?.conversations.find(
      (c) => c.id === conversationId,
    ),
    branch = conversation?.branches.find((b) => b.id === branchId);
  const turns =
    conversation?.turns.filter(
      (t) =>
        (!branch || branch.turnIds.includes(t.id)) &&
        (!query || t.text.toLowerCase().includes(query.toLowerCase())),
    ) ?? [];
  const current = proposals.find((p) => p.id === active);
  const currentJobItem = jobView?.items.find((i) => i.id === current?.id);
  function choose(cid: string, result = parsed) {
    const c = result?.conversations.find((c) => c.id === cid);
    setConversationId(cid);
    setBranchId(
      c?.branches.find((b) => b.current)?.id ?? c?.branches[0]?.id ?? "",
    );
    setSelection({});
    setQuery("");
    setPage(0);
  }
  function parse(raw: string) {
    setError("");
    setNotice("");
    try {
      const result = parseImport(raw, format);
      setParsed(result);
      choose(result.conversations[0].id, result);
      setPaste("");
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The file could not be parsed.",
      );
    }
  }
  async function load(file: File | undefined, resume = false) {
    if (!file) return;
    const turn = ++generation.current;
    setBusy(true);
    setError("");
    try {
      if (file.size > MAX_FILE_BYTES)
        throw new Error("Choose a file smaller than 10 MB.");
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          await file.arrayBuffer(),
        );
      } catch {
        throw new Error("Choose a UTF-8 JSON or JSONL file.");
      }
      if (turn !== generation.current) return;
      if (resume) {
        const saved = readCheckpoint(raw);
        if (saved.jobId && trackedJobId && saved.jobId !== trackedJobId)
          throw new Error(
            "This review file belongs to another job. Clear the local session before attaching it.",
          );
        const existing = new Set(proposals.map(identity)),
          incoming = saved.proposals.filter((p) => !existing.has(identity(p)));
        if (incoming.some((p) => proposals.some((q) => q.id === p.id)))
          throw new Error(
            "A proposal ID conflicts with an existing draft. Resume this review file in a cleared session.",
          );
        if (proposals.length + incoming.length > 100)
          throw new Error("A review batch can contain at most 100 proposals.");
        setProposals((v) => [
          ...v,
          ...incoming.map((p) => ({
            ...p,
            decision: p.decision === "saved" ? ("draft" as const) : p.decision,
          })),
        ]);
        if (saved.jobId) {
          setTrackedJobId(saved.jobId);
          setJobView(null);
        }
        setDirty(true);
        setNotice(
          "Checkpoint restored. Prior saved references are unverified hints; Notion will be checked again before another import.",
        );
      } else parse(raw);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The file could not be opened.",
      );
    } finally {
      if (turn === generation.current) setBusy(false);
      if (fileInput.current) fileInput.current.value = "";
      if (checkpointInput.current) checkpointInput.current.value = "";
    }
  }
  function stage() {
    if (!conversation) return;
    setError("");
    const drafts: Proposal[] = [];
    try {
      for (const t of conversation.turns)
        if (Object.hasOwn(selection, t.id))
          drafts.push(makeProposal(conversation, t, selection[t.id]));
      const existing = new Set(proposals.map(identity)),
        fresh = drafts.filter((p) => !existing.has(identity(p)));
      if (proposals.length + fresh.length > 100)
        throw new Error(
          "A review batch can contain at most 100 proposals. Finish or clear this batch first.",
        );
      if (!fresh.length)
        throw new Error(
          "These sources are already staged. Edit their existing proposals.",
        );
      setProposals((v) => [...v, ...fresh]);
      setSelection({});
      setDirty(true);
      setNotice(
        fresh.length +
          " unsaved proposals staged. Titles and categories are simple local suggestions; inspect and edit each one.",
      );
      setActive(fresh[0].id);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Review the selected evidence. Each excerpt must contain 1–6000 characters.",
      );
    }
  }
  function exportProgress() {
    try {
      const blob = new Blob(
          [downloadCheckpoint(proposals, trackedJobId ?? undefined)],
          {
            type: "application/json",
          },
        ),
        url = URL.createObjectURL(blob),
        a = document.createElement("a");
      a.href = url;
      a.download = "idea-lab-review.json";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setDirty(false);
      setNotice(
        "Review file downloaded. It contains only selected evidence and drafts, with no approval tokens. Keep it private.",
      );
    } catch {
      setError(
        "A draft has invalid fields. Complete its title and summary before downloading progress.",
      );
    }
  }
  function reset() {
    setNotionKey((v) => v + 1);
    setQueued({});
    setTrackedJobId(null);
    setJobView(null);
    generation.current++;
    setBusy(false);
    setParsed(null);
    setSelection({});
    setProposals([]);
    setActive(null);
    setPaste("");
    setExtra("");
    setDirty(false);
    setClear(false);
    setError("");
    setNotice("Import text and proposals cleared from this page.");
  }
  return (
    <div className="page import-page">
      <fieldset className="import-ready" disabled={!ready}>
        <div className="page-heading">
          <div>
            <div className="eyebrow">EVERY SPARK HAS A STORY</div>
            <h1>
              Bring your ideas together<span>.</span>
            </h1>
            <p>Pick the conversations. Keep the evidence. Review each idea.</p>
          </div>
        </div>
        <div className="notice">
          <ShieldCheck size={20} />
          <div>
            <strong>File previews stay in your browser.</strong>
            <p>
              Files are read locally. No history is uploaded and no AI endpoint
              is called for file previews. The Notion selector below explicitly
              reads chosen content through the Site. Requesting a proposal
              review sends only its displayed fields and selected evidence to
              the Idea Lab server. An approved save writes them to Notion.
            </p>
          </div>
        </div>
        <div className="import-toolbar">
          <button
            className="site-secondary"
            onClick={() => checkpointInput.current?.click()}
            disabled={busy}
          >
            <Upload size={15} />
            Resume review file
          </button>
          <input
            ref={checkpointInput}
            aria-label="Resume review file"
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => void load(e.target.files?.[0], true)}
          />
          <button
            className="site-secondary"
            disabled={!proposals.length}
            onClick={exportProgress}
          >
            <Download size={15} />
            Download progress
          </button>
          <button className="site-secondary" onClick={() => setClear(true)}>
            <Trash2 size={15} />
            Clear local session
          </button>
        </div>
        {clear && (
          <div className="notice">
            <p>
              Clear all local source text and unsaved proposals? Download
              progress first if you want to resume later.
            </p>
            <button className="site-secondary" onClick={() => setClear(false)}>
              Keep working
            </button>
            <button className="site-primary" onClick={reset}>
              Clear this session
            </button>
          </div>
        )}
        {error && (
          <div className="form-error" role="alert">
            {error}
          </div>
        )}
        {notice && (
          <p className="notice" role="status">
            {notice}
          </p>
        )}
        <section className="panel prose-panel import-load">
          <div className="section-heading">
            <div>
              <span className="tiny-label">01 · SELECT</span>
              <h2>Open a conversation export</h2>
            </div>
            <span className="pill">10 MB maximum</span>
          </div>
          <div className="import-controls">
            <label>
              Source format
              <select
                aria-label="Source format"
                value={format}
                onChange={(e) => {
                  setFormat(e.target.value as typeof format);
                  setPaste("");
                }}
              >
                <option value="chatgpt">ChatGPT JSON export</option>
                <option value="claude">Claude Code JSONL transcript</option>
                <option value="codex">Codex JSONL rollout</option>
              </select>
            </label>
            <button
              className="site-primary"
              disabled={busy}
              onClick={() => fileInput.current?.click()}
            >
              <Upload size={16} />
              {busy ? "Opening…" : "Choose a file"}
            </button>
            <input
              aria-label="Source file"
              ref={fileInput}
              type="file"
              accept={
                format === "chatgpt"
                  ? ".json,application/json"
                  : ".jsonl,.json,application/json"
              }
              hidden
              onChange={(e) => void load(e.target.files?.[0])}
            />
          </div>
          <details>
            <summary>Or paste selected JSON / JSONL</summary>
            <label className="import-paste">
              Export text
              <textarea
                rows={5}
                value={paste}
                maxLength={MAX_FILE_BYTES}
                onChange={(e) => setPaste(e.target.value)}
                spellCheck={false}
              />
            </label>
            <button
              className="site-secondary"
              disabled={!paste.trim() || busy}
              onClick={() => parse(paste)}
            >
              Preview pasted export
            </button>
          </details>
          <p className="subtle-note">
            Extract a JSON/JSONL file from your export first; ZIP archives and
            automatic filesystem scanning are not supported. Export structures
            change, so unsupported records are reported. Keep original files
            unchanged for reliable reimport.
          </p>
        </section>
        <NotionSelector
          key={notionKey}
          onPreview={(result) => {
            generation.current++;
            setBusy(false);
            setParsed(result);
            choose(result.conversations[0].id, result);
            setError("");
            setNotice(
              "Selected Notion content loaded. Choose individual excerpts, check redaction and stage unsaved proposals.",
            );
          }}
        />
        {parsed && conversation && (
          <section className="panel prose-panel">
            <span className="tiny-label">02 · FILTER & REDACT</span>
            <h2>Choose the evidence</h2>
            {parsed.warnings.map((w, i) => (
              <p className="subtle-note" key={i}>
                {w}
              </p>
            ))}
            <div className="editor-select-grid">
              <label>
                {conversation.system === "Notion"
                  ? "Selected Notion page"
                  : "Conversation"}
                <select
                  value={conversationId}
                  onChange={(e) => choose(e.target.value)}
                >
                  {parsed.conversations.map((c) => (
                    <option value={c.id} key={c.id}>
                      {c.title} · {c.turns.length} turns
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Branch
                <select
                  value={branchId}
                  onChange={(e) => {
                    setBranchId(e.target.value);
                    setSelection({});
                    setPage(0);
                  }}
                >
                  {conversation.branches.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.label}
                      {b.current ? " · current" : ""} · {b.turnIds.length} turns
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Extra phrases to redact (one per line)
              <textarea
                rows={2}
                maxLength={6000}
                value={extra}
                onChange={(e) => setExtra(e.target.value)}
                placeholder="Project names or private details"
              />
            </label>
            <button
              className="site-secondary"
              onClick={() =>
                setSelection((v) =>
                  Object.fromEntries(
                    Object.entries(v).map(([key, text]) => [
                      key,
                      redact(text, extra.split("\n")),
                    ]),
                  ),
                )
              }
            >
              Apply redaction to selected text
            </button>
            <p className="subtle-note">
              Common tokens, emails, private keys and home paths are redacted
              automatically. Check every excerpt; pattern matching cannot find
              all sensitive information. Edit selected evidence directly.
              Assistant text may contain suggestions that you never adopted.
            </p>
            <label>
              Find text in this branch
              <input
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
            </label>
            <div className="import-turns">
              {turns.slice(page * 25, page * 25 + 25).map((t) => {
                const checked = Object.hasOwn(selection, t.id),
                  preview = redact(t.text, extra.split("\n"));
                return (
                  <article
                    key={t.id}
                    className={
                      checked ? "import-turn selected-turn" : "import-turn"
                    }
                  >
                    <label className="turn-select">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) =>
                          setSelection((v) => {
                            const next = { ...v };
                            if (e.target.checked)
                              return { ...v, [t.id]: preview };
                            else delete next[t.id];
                            return next;
                          })
                        }
                      />
                      <strong>
                        {t.role === "document"
                          ? "Notion document"
                          : t.role === "user"
                            ? "You"
                            : "Assistant"}
                      </strong>
                      <span className="pill">{suggestion(preview)}</span>
                    </label>
                    <small>
                      {t.messageId} · {t.date ?? "Date unknown"}
                    </small>
                    {checked ? (
                      <label>
                        Selected evidence
                        <textarea
                          aria-label="Selected evidence"
                          value={selection[t.id]}
                          rows={5}
                          maxLength={6000}
                          onChange={(e) =>
                            setSelection((v) => ({
                              ...v,
                              [t.id]: e.target.value,
                            }))
                          }
                        />
                        <small>
                          {selection[t.id].length} / 6000 characters · shorten
                          oversized turns before staging
                        </small>
                      </label>
                    ) : (
                      <p className="preserve-text">
                        {preview.slice(0, 1200)}
                        {preview.length > 1200
                          ? "… (select to edit the full excerpt)"
                          : ""}
                      </p>
                    )}
                  </article>
                );
              })}
            </div>
            <div className="import-toolbar">
              <button
                className="site-secondary"
                disabled={page === 0}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous turns
              </button>
              <span>
                {turns.length ? Math.min(page * 25 + 1, turns.length) : 0}–
                {Math.min(page * 25 + 25, turns.length)} of {turns.length}
              </span>
              <button
                className="site-secondary"
                disabled={(page + 1) * 25 >= turns.length}
                onClick={() => setPage((p) => p + 1)}
              >
                Next turns
              </button>
            </div>
            <div className="import-toolbar">
              <button
                className="site-primary"
                disabled={!Object.keys(selection).length}
                onClick={stage}
              >
                Stage {Object.keys(selection).length} selected turns{" "}
                <ArrowRight size={16} />
              </button>
              <button
                className="site-secondary"
                onClick={() => setSelection({})}
              >
                Clear selection
              </button>
            </div>
          </section>
        )}
        {proposals.length > 0 && (
          <section className="panel prose-panel">
            <span className="tiny-label">03 · REVIEW</span>
            <h2>Your import batch</h2>
            <p>
              {proposals.filter((p) => p.decision === "draft").length} drafts ·{" "}
              {proposals.filter((p) => p.decision === "rejected").length}{" "}
              skipped locally ·{" "}
              {proposals.filter((p) => p.decision === "saved").length} confirmed
              saves this session. Each proposal needs its own explicit approval.
            </p>
            <p className="subtle-note">
              Drafts stay in memory until you download progress. A local skip is
              not an authoritative Notion review decision. Saved references
              restored from a file must be verified again.
            </p>
            <div className="import-proposals">
              {proposals.map((p) => (
                <div className="import-proposal" key={p.id}>
                  <button
                    className={
                      "proposal-choice " + (active === p.id ? "active" : "")
                    }
                    onClick={() => setActive(p.id)}
                  >
                    <strong>{p.data.title || "Untitled draft"}</strong>
                    <small>
                      {p.source.system} · {p.decision}
                    </small>
                  </button>
                  {p.decision !== "saved" && (
                    <button
                      className="text-link"
                      onClick={() => {
                        setProposals((v) =>
                          v.map((q) =>
                            q.id === p.id
                              ? {
                                  ...q,
                                  decision:
                                    q.decision === "rejected"
                                      ? "draft"
                                      : "rejected",
                                }
                              : q,
                          ),
                        );
                        setDirty(true);
                        if (active === p.id) setActive(null);
                      }}
                    >
                      {p.decision === "rejected"
                        ? "Restore draft"
                        : "Skip locally"}
                    </button>
                  )}
                  {p.canonicalId && (
                    <Link
                      className="text-link"
                      href={"/ideas/" + p.canonicalId}
                    >
                      Inspect canonical record
                    </Link>
                  )}
                </div>
              ))}
            </div>
          </section>
        )}
        <ImportJobs
          proposals={proposals}
          jobId={trackedJobId}
          refresh={jobRefresh}
          onJob={(job) => {
            setTrackedJobId(job?.id ?? null);
            setJobView(job);
          }}
          onChoose={setActive}
          onSaved={(itemId, ideaId, snapshot) =>
            setProposals((old) =>
              old.some(
                (p) =>
                  p.id === itemId &&
                  JSON.stringify([p.data, p.source]) === snapshot &&
                  (p.decision !== "saved" || p.canonicalId !== ideaId),
              )
                ? old.map((p) =>
                    p.id === itemId &&
                    JSON.stringify([p.data, p.source]) === snapshot
                      ? { ...p, decision: "saved", canonicalId: ideaId }
                      : p,
                  )
                : old,
            )
          }
        />
        {trackedJobId && !jobView && (
          <p className="notice">
            Loading saved import progress before enabling another save…
          </p>
        )}
        {current && proposals.length > 1 && (
          <DraftComparison
            key={current.id}
            current={current}
            proposals={proposals}
            onSkip={(id) => {
              setProposals((v) =>
                v.map((p) =>
                  p.id === id ? { ...p, decision: "rejected" } : p,
                ),
              );
              setDirty(true);
            }}
          />
        )}
        {current?.decision === "draft" && !queued[current.id] && (
          <AIExtraction
            key={"ai:" + current.id}
            source={current.source}
            initial={current.ai}
            onResult={(result) => {
              setProposals((v) =>
                v.map((p) =>
                  p.id === current.id
                    ? {
                        ...p,
                        ai: result,
                        source: result.input.source,
                        data: result.data ?? p.data,
                      }
                    : p,
                ),
              );
              setDirty(true);
              setNotice(
                "AI result preserved in this local draft. Review the fields before storing a proposal.",
              );
            }}
          />
        )}
        {current?.decision === "draft" && !queued[current.id] && (
          <SaveProposal
            key={"queue:" + current.id}
            data={current.data}
            source={current.source}
            ai={current.ai}
            onQueued={(id) => setQueued((v) => ({ ...v, [current.id]: id }))}
          />
        )}
        {current && queued[current.id] && (
          <section className="panel prose-panel">
            <p>This draft is saved for review in Notion.</p>
            <Link
              className="site-primary"
              href={"/review/proposals/" + queued[current.id]}
            >
              Review saved proposal
            </Link>
          </section>
        )}
        {current?.decision === "draft" &&
          !queued[current.id] &&
          (!trackedJobId || jobView) && (
            <IdeaEditor
              key={current.id + (current.ai?.runId ?? "manual")}
              importJob={
                currentJobItem && jobView
                  ? {
                      jobId: jobView.id,
                      itemId: currentJobItem.id,
                      stopped: jobView.status !== "active" || jobView.expired,
                      blocked:
                        ["running", "check"].includes(currentJobItem.status) ||
                        currentJobItem.attempts >=
                          currentJobItem.attemptLimit ||
                        !!currentJobItem.notBefore,
                    }
                  : undefined
              }
              onImportProgress={() => setJobRefresh((n) => n + 1)}
              draftOnly={!!current.ai}
              initialDraft={current.data}
              source={current.source}
              onDraftChange={(data) => {
                setProposals((v) =>
                  v.map((p) => (p.id === current.id ? { ...p, data } : p)),
                );
                setDirty(true);
              }}
              onSaved={(idea) => {
                setProposals((v) =>
                  v.map((p) =>
                    p.id === current.id
                      ? { ...p, decision: "saved", canonicalId: idea.id }
                      : p,
                  ),
                );
                setDirty(true);
                setNotice(
                  "Confirmed canonical save. Download progress before leaving this session.",
                );
              }}
            />
          )}
        {current?.decision === "saved" && (
          <div className="notice">
            <Check size={18} />
            <p>
              Saved to Notion. Open its canonical record from the batch above.
            </p>
          </div>
        )}
        <p className="subtle-note">
          GitHub content collectors, unattended scheduling and merge actions are
          tracked separately. Import jobs advance only through your reviewed
          actions. This workspace never executes instructions found in imported
          text.
        </p>
      </fieldset>
    </div>
  );
}
