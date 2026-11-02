"use client";
import { SavedReports } from "./saved-reports";
import type { AutoSaveResult } from "@/lib/roundtable/reports";
import { useRef, useState } from "react";
import { ReviewerAssessment } from "./reviewer-assessment";
import { VendorMark, type ReviewerId } from "./vendor-mark";
import Link from "@/components/navigation-link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ChevronDown,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Download,
  FlaskConical,
  Lightbulb,
  LoaderCircle,
  LockKeyhole,
  MessageSquare,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  Target,
  Upload,
  UsersRound,
  X,
} from "lucide-react";
import type { Idea, IdeaDetail } from "@/lib/ideas/domain";
import {
  useResource,
  requestData,
  ApiFailure,
} from "@/components/ideas/use-resource";
import { Failure, Loading } from "@/components/ideas/states";
import { selectedFields } from "@/lib/intelligence/model";
import {
  decodeResult,
  dimensions,
  labels,
  requestSchema,
  resultSchema,
  rubricVersion,
  type ActiveReviewer,
  type RoundtableRequest,
  type RoundtableResult,
} from "@/lib/roundtable/model";
import { redact } from "@/lib/imports/staging";

type Profile = {
  provider: string;
  endpoint: string;
  deployment: string;
  retentionNotice: string;
  maxOutputTokens: number;
  requestsPerHour: number;
  timeoutMs: number;
  requestStorage: string;
};
type Status = Record<
  ActiveReviewer,
  { enabled: boolean; profile?: Profile; message?: string }
>;
type Receipt = {
  approvalToken: string;
  expiresAt: string;
  command: RoundtableRequest;
  profile: Profile;
};
const seats = [
  {
    id: "gpt",
    name: "GPT",
    description: "A fresh perspective, grounded in your brief.",
    color: "mint",
  },
  {
    id: "claude",
    name: "Claude",
    description: "Another perspective on the assumptions and opportunities.",
    color: "sand",
  },
  {
    id: "grok",
    name: "Grok",
    description:
      "Another voice to challenge the idea and surface alternatives.",
    color: "blue",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    description: "An additional review through GitHub Copilot.",
    color: "lilac",
  },
] as const;
const fieldLabels: Record<string, string> = {
  title: "Title",
  summary: "Summary",
  problem: "Problem",
  solution: "Proposed solution",
  audience: "Audience",
  expectedValue: "Expected value",
  context: "Context",
};

export function RoundtableWorkspace({ id }: { id?: string }) {
  return id ? <Bound key={id} id={id} /> : <Roundtable />;
}
function Bound({ id }: { id: string }) {
  const r = useResource<IdeaDetail>("/api/ideas/" + id);
  if (r.error)
    return (
      <div className="page">
        <Failure error={r.error} retry={r.refresh} />
      </div>
    );
  if (!r.data)
    return (
      <div className="page">
        <Loading />
      </div>
    );
  return <Roundtable key={r.data.idea.revision} idea={r.data.idea} />;
}
function IdeaPicker() {
  const r = useResource<Idea[]>("/api/ideas"),
    router = useRouter();
  return (
    <div className="rt-picker">
      <label htmlFor="rt-idea">Bring an idea to the table</label>
      {r.error ? (
        <Failure error={r.error} retry={r.refresh} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.length ? (
        <select
          id="rt-idea"
          value=""
          onChange={(e) => {
            if (e.target.value)
              router.push("/ideas/" + e.target.value + "/roundtable");
          }}
        >
          <option value="" disabled>
            Choose an idea from your lab…
          </option>
          {r.data.map((idea) => (
            <option key={idea.id} value={idea.id}>
              {idea.title || "Untitled record"}
            </option>
          ))}
        </select>
      ) : (
        <p>
          No ideas yet.{" "}
          <Link href="/ideas/new" className="text-link">
            Capture your first idea <ArrowRight size={14} />
          </Link>
        </p>
      )}
    </div>
  );
}
function Roundtable({ idea }: { idea?: Idea }) {
  const profile = useResource<Status>("/api/roundtable/status");
  const [selected, setSelected] = useState<ReviewerId>("gpt"),
    [selection, setSelection] = useState<
      Partial<Record<(typeof selectedFields)[number], string>>
    >({}),
    [criteria, setCriteria] = useState(""),
    [constraints, setConstraints] = useState("");
  const [saving, setSaving] = useState(false);
  const [storages, setStorages] = useState<
    Partial<Record<ActiveReviewer, AutoSaveResult | null>>
  >({});
  const activeReviewer: ActiveReviewer =
    selected === "claude" ? "claude" : "gpt";
  const name = activeReviewer === "claude" ? "Claude" : "GPT";
  const storage = storages[activeReviewer] ?? null;
  function setStorage(value: AutoSaveResult | null) {
    setStorages((previous) => ({ ...previous, [activeReviewer]: value }));
  }
  const [results, setResults] = useState<
    Partial<Record<ActiveReviewer, RoundtableResult | null>>
  >({});
  const result = results[activeReviewer] ?? null;
  function setResult(value: RoundtableResult | null) {
    setResults((previous) => ({
      ...previous,
      [value?.participant ?? activeReviewer]: value,
    }));
  }
  const [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [checked, setChecked] = useState(false),
    [restored, setRestored] = useState(false);
  const reviewerPanel = useRef<HTMLElement>(null);
  const guard = useRef(false),
    file = useRef<HTMLInputElement>(null);
  const locked = busy || saving || !!receipt || uncertain;
  const gpt = profile.data?.[activeReviewer],
    seat = seats.find((s) => s.id === selected)!;
  function state(id: string) {
    if (id !== "gpt" && id !== "claude") return "Coming next";
    if (busy && receipt && id === activeReviewer) return "Reviewing…";
    if (results[id]) return "Assessment ready";
    if (uncertain && id === activeReviewer) return "Check request";
    return profile.data?.[id]?.enabled
      ? "Ready to review"
      : profile.error
        ? "Connection unavailable"
        : !profile.data
          ? "Checking connection…"
          : "Connection needed";
  }
  function reuseGPTBrief() {
    const previous = results.gpt;
    if (!previous || locked) return;
    setSelection(previous.input.selection);
    setCriteria(previous.input.successCriteria);
    setConstraints(previous.input.constraints);
    setMessage(
      "Reusing the exact brief assessed by GPT. Review it below before sending to Claude.",
    );
  }
  async function prepare() {
    if (guard.current || !idea) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const command = requestSchema.safeParse({
        ideaId: idea.id,
        inputRevision: idea.revision,
        selection,
        successCriteria: criteria,
        constraints,
        rubricVersion,
      });
      if (!command.success)
        throw new Error(
          command.error.issues[0]?.message ?? "Complete the idea brief.",
        );
      setReceipt(
        await requestData<Receipt>(
          "/api/roundtable/prepare?reviewer=" + activeReviewer,
          {
            method: "POST",
            body: JSON.stringify(command.data),
          },
        ),
      );
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "The request could not be prepared.",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function send() {
    if (guard.current || !receipt) return;
    guard.current = true;
    setBusy(true);
    setError("");
    setMessage("");
    setResult(null);
    setStorage(null);
    setRestored(false);
    try {
      const response = await requestData<{
        result: RoundtableResult;
        storage: AutoSaveResult;
      }>("/api/roundtable/commit?reviewer=" + activeReviewer, {
        method: "POST",
        body: JSON.stringify({
          command: receipt.command,
          approvalToken: receipt.approvalToken,
        }),
      });
      setResult(resultSchema.parse(response.result));
      setStorage(response.storage);
      setReceipt(null);
      setSelected(response.result.participant);
      setMessage(
        response.storage?.status === "saved"
          ? `${name}’s assessment is ready and automatically saved to Notion.`
          : `${name}’s assessment is ready. Automatic saving needs attention below; the model will not be run again.`,
      );
    } catch (e) {
      const unknown =
        !(e instanceof ApiFailure) ||
        e.uncertain ||
        ["AI_RESULT_NOT_RETAINED", "RECONCILIATION_REQUIRED"].includes(e.code);
      setUncertain(unknown);
      if (!unknown) setReceipt(null);
      setError(
        e instanceof Error
          ? e.message
          : "The request could not be confirmed. Check its status before proceeding.",
      );
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  async function checkStatus() {
    if (guard.current || !receipt) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      const response = await requestData<{
        status: string;
        message: string;
        result?: RoundtableResult;
        storage?: AutoSaveResult;
      }>("/api/roundtable/request-status", {
        method: "POST",
        body: JSON.stringify({ approvalToken: receipt.approvalToken }),
      });
      setMessage(response.message);
      if (response.result) {
        setResult(resultSchema.parse(response.result));
        setStorage(response.storage ?? null);
        setUncertain(false);
        setReceipt(null);
        return;
      }
      setChecked(["done", "uncertain"].includes(response.status));
      if (["failed", "pending"].includes(response.status)) {
        setUncertain(false);
        setReceipt(null);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Status could not be checked.");
    } finally {
      guard.current = false;
      setBusy(false);
    }
  }
  function download() {
    if (!result) return;
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(result, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "idea-lab-" + result.participant + "-assessment.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function restore(f: File | undefined) {
    if (!f || locked || guard.current) return;
    guard.current = true;
    setBusy(true);
    setError("");
    try {
      if (f.size > 100000)
        throw new Error("Choose a result smaller than 100 KB.");
      const loaded = decodeResult(
        new TextDecoder("utf-8", { fatal: true }).decode(await f.arrayBuffer()),
      );
      if (
        !idea ||
        loaded.input.ideaId !== idea.id ||
        loaded.input.inputRevision !== idea.revision
      )
        throw new Error(
          "This result belongs to a different idea or an older revision. Open the matching idea before loading it.",
        );
      setResult(loaded);
      setStorage(null);
      setRestored(true);
      setSelected(loaded.participant);
      setMessage(
        "Loaded a private result file. Its provider provenance has not been verified by the server.",
      );
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "This result file could not be loaded.",
      );
    } finally {
      guard.current = false;
      setBusy(false);
      if (file.current) file.current.value = "";
    }
  }
  const selectedResult = result?.participant === selected ? result : null;
  function selectReviewer(id: ReviewerId) {
    if (locked) return;
    if (id === "claude" && results.gpt) reuseGPTBrief();
    setSelected(id);
    reviewerPanel.current?.scrollTo({ top: 0 });
    if (window.matchMedia("(max-width: 760px)").matches)
      reviewerPanel.current?.scrollIntoView({
        block: "start",
        behavior: "instant",
      });
  }
  return (
    <div className="page rt-page">
      <header className="page-heading rt-heading">
        <div>
          <div className="eyebrow">A FEW MORE MINDS. A CLEARER NEXT STEP.</div>
          <h1>
            The roundtable<span>.</span>
          </h1>
          <p>
            Give your idea room to be challenged. Find out what makes it worth
            pursuing.
          </p>
        </div>
        <span className="rt-release">
          <span />
          GPT + Claude · independent reviewers
        </span>
      </header>
      <ol className="rt-stages" aria-label="Review stages">
        <li aria-current="step">
          <span className="rt-stage-number">01</span>
          <div>
            <strong>Independent perspectives</strong>
            <small>Independent assessments from GPT and Claude</small>
          </div>
        </li>
        <li>
          <span className="rt-stage-number">02</span>
          <div>
            <strong>Challenge & expand</strong>
            <small>Available as reviewers join</small>
          </div>
          <LockKeyhole size={14} />
        </li>
        <li>
          <span className="rt-stage-number">03</span>
          <div>
            <strong>Find the way forward</strong>
            <small>Panel ranking follows cross-review</small>
          </div>
          <LockKeyhole size={14} />
        </li>
      </ol>
      {idea && (
        <SavedReports
          idea={idea}
          participant={activeReviewer}
          onHistory={(reports) => {
            setResults((previous) => {
              const next = { ...previous };
              for (const reviewer of ["gpt", "claude"] as const) {
                if (next[reviewer]) continue;
                const candidates = reports.filter(
                  (row) => row.snapshot.result.participant === reviewer,
                );
                const report =
                  candidates.find(
                    (row) =>
                      row.snapshot.result.input.inputRevision === idea.revision,
                  ) ?? candidates[0];
                if (report)
                  next[reviewer] = resultSchema.parse(report.snapshot.result);
              }
              return next;
            });
          }}
          onBusyChange={setSaving}
          result={result}
          storage={storage}
          busy={busy || !!receipt || uncertain}
          onLoad={(saved) => {
            setResult(saved);
            setStorage(null);
            setRestored(false);
            setSelected(saved.participant);
            if (saved.input.inputRevision === idea.revision) {
              setSelection(saved.input.selection);
              setCriteria(saved.input.successCriteria);
              setConstraints(saved.input.constraints);
            }
          }}
        />
      )}
      <div className="rt-layout">
        <section
          className="panel rt-table-panel"
          aria-labelledby="rt-table-title"
        >
          <div className="rt-section-label">
            <span>
              <UsersRound size={17} /> YOUR REVIEW PANEL
            </span>
            <small>Select a reviewer to explore its assessment</small>
          </div>
          <h2 id="rt-table-title" className="rt-visually-hidden">
            Choose a reviewer
          </h2>
          <div className="rt-table-scene">
            <div className="rt-orbit" aria-hidden="true" />
            <div className="rt-table-centre">
              <span className="rt-idea-icon">
                <Lightbulb size={23} />
              </span>
              <small>ON THE TABLE</small>
              <h2>{idea?.title || "Your next possibility"}</h2>
              <span>{idea ? idea.category : "Choose an idea to begin"}</span>
            </div>
            {seats.map((s) => (
              <button
                type="button"
                key={s.id}
                className={
                  "rt-seat rt-seat-" +
                  s.id +
                  (selected === s.id ? " is-selected" : "")
                }
                onClick={() => selectReviewer(s.id)}
                disabled={locked}
                aria-controls="rt-reviewer-detail"
                aria-pressed={selected === s.id}
                aria-label={s.name + ": " + state(s.id)}
              >
                <span className="rt-seat-score-ring">
                  <span className={"rt-avatar " + s.color}>
                    <VendorMark id={s.id} />
                  </span>
                  {dimensions.map((key) => (
                    <span
                      key={key}
                      className={"rt-seat-score rt-seat-score-" + key}
                      aria-label={
                        labels[key] +
                        ": " +
                        (!!results[s.id as ActiveReviewer]
                          ? (results[s.id as ActiveReviewer]!.assessment
                              .ratings[key].score ?? "not enough evidence")
                          : "not assessed")
                      }
                    >
                      <abbr title={labels[key]}>
                        {key === "feasibility"
                          ? "F"
                          : key === "success"
                            ? "S"
                            : "V"}
                      </abbr>
                      <strong>
                        {!!results[s.id as ActiveReviewer]
                          ? (results[s.id as ActiveReviewer]!.assessment
                              .ratings[key].score ?? "—")
                          : "—"}
                      </strong>
                    </span>
                  ))}
                </span>
                <strong>{s.name}</strong>
                <small>
                  <i
                    className={
                      (s.id === "gpt" || s.id === "claude") &&
                      profile.data?.[s.id]?.enabled
                        ? "ready"
                        : ""
                    }
                  />
                  {state(s.id)}
                </small>
              </button>
            ))}
          </div>
          <div className="rt-table-caption">
            <ShieldCheck size={15} />
            <p>
              <span className="rt-score-legend">
                <span>F · Feasibility</span>
                <span>S · Success</span>
                <span>V · Value offered</span>
              </span>
              Scores belong to each reviewer. Select its icon to see the
              evidence.
            </p>
          </div>
        </section>
        <aside
          className={
            "panel rt-reviewer-panel" +
            (selectedResult ? " has-assessment" : "")
          }
          id="rt-reviewer-detail"
          ref={reviewerPanel}
          aria-label="Selected reviewer"
        >
          <div className="rt-section-label">
            <span>AT THIS SEAT</span>
            <span
              className={
                "rt-chip " +
                (selected === "gpt" || selected === "claude" ? "active" : "")
              }
            >
              {selected === "gpt" || selected === "claude"
                ? "INDEPENDENT REVIEWER"
                : "COMING NEXT"}
            </span>
          </div>
          <span className={"rt-avatar rt-inspector-avatar " + seat.color}>
            <VendorMark id={seat.id} />
          </span>
          <h2>{seat.name}</h2>
          <p>{seat.description}</p>
          <div className="rt-reviewer-status">
            <span className="rt-status-dot" />
            {state(selected)}
          </div>
          {selected === "gpt" || selected === "claude" ? (
            <>
              {profile.error ? (
                <Failure error={profile.error} retry={profile.refresh} />
              ) : gpt?.enabled ? (
                <p className="rt-model-label">
                  Model <strong>{gpt.profile?.deployment}</strong>
                  <br />
                  {gpt.profile?.provider === "anthropic-messages"
                    ? "Anthropic Messages API"
                    : gpt.profile?.provider === "openai-responses"
                      ? "OpenAI Responses API"
                      : "Azure OpenAI"}
                </p>
              ) : (
                <div className="rt-connection-note">
                  <LockKeyhole size={16} />
                  <p>
                    {gpt?.message || `Checking ${name} connection…`}{" "}
                    <Link href="/settings" className="text-link">
                      Open settings <ArrowUpRight size={12} />
                    </Link>
                  </p>
                </div>
              )}
              {selectedResult ? (
                <ReviewerAssessment
                  key={selectedResult.runId}
                  result={selectedResult}
                  restored={restored}
                  onDownload={download}
                />
              ) : (
                <>
                  <h3>{name}’s scores</h3>
                  <div className="rt-empty-scores">
                    {dimensions.map((key) => (
                      <div key={key}>
                        <span>{labels[key]}</span>
                        <strong>
                          —<small>/100</small>
                        </strong>
                      </div>
                    ))}
                  </div>
                  <p className="rt-agent-score-note">
                    No assessment yet. Complete the idea brief below to request
                    {name}’s independent review.
                  </p>
                  <h3>What {name} will bring</h3>
                  <ul className="rt-check-list">
                    <li>
                      <Check size={14} />A grounded viability assessment
                    </li>
                    <li>
                      <Check size={14} />
                      Weak spots & untested assumptions
                    </li>
                    <li>
                      <Check size={14} />
                      Ways to develop the idea
                    </li>
                    <li>
                      <Check size={14} />
                      Small experiments to test next
                    </li>
                  </ul>
                </>
              )}
            </>
          ) : (
            <div className="rt-coming-note">
              <MessageSquare size={22} />
              <div
                className="rt-empty-scores"
                aria-label={seat.name + " scores"}
              >
                {dimensions.map((key) => (
                  <div key={key}>
                    <span>{labels[key]}</span>
                    <strong>
                      —<small>/100</small>
                    </strong>
                  </div>
                ))}
              </div>
              <h3>No assessment from {seat.name} yet.</h3>
              <p>
                {seat.name} will contribute a separate assessment, then review
                the other perspectives once its integration is available.
              </p>
              <button
                type="button"
                className="site-secondary"
                onClick={() => selectReviewer("gpt")}
              >
                Return to GPT <ArrowRight size={14} />
              </button>
            </div>
          )}
        </aside>
      </div>
      <details className="rt-brief-disclosure" open={!result || !!receipt}>
        <summary>
          {result
            ? "Idea brief & request another assessment"
            : "Prepare the idea brief"}
          <ChevronDown size={16} />
        </summary>
        {!idea ? (
          <section className="panel rt-brief">
            <div className="rt-section-label">
              <span>START WITH A POSSIBILITY</span>
            </div>
            <IdeaPicker />
          </section>
        ) : (
          <>
            <section
              className="panel rt-brief"
              aria-labelledby="rt-brief-title"
            >
              <div className="section-heading">
                <div>
                  <div className="eyebrow">THE IDEA BRIEF</div>
                  <h2 id="rt-brief-title">
                    Good questions start with the right context.
                  </h2>
                  <p>
                    Choose what {name} can read. Edit or redact any excerpt
                    before reviewing the request.
                  </p>
                </div>
                <Link className="text-link" href={"/ideas/" + idea.id}>
                  View idea <ArrowUpRight size={14} />
                </Link>
              </div>
              {activeReviewer === "claude" && results.gpt && (
                <div className="rt-save-warning">
                  <p>
                    Reuse the same excerpts, success criteria, constraints and
                    scoring rubric that GPT assessed. Claude receives an
                    independent brief, without GPT’s answers.
                  </p>
                  <button
                    type="button"
                    className="site-secondary"
                    disabled={locked}
                    onClick={reuseGPTBrief}
                  >
                    Reuse GPT’s assessed brief
                  </button>
                </div>
              )}
              <fieldset disabled={locked} className="rt-fields">
                <legend>Idea excerpts</legend>
                <div className="rt-excerpt-options">
                  {selectedFields.map((key) => (
                    <label key={key}>
                      <input
                        type="checkbox"
                        checked={key in selection}
                        disabled={!idea[key]?.trim()}
                        onChange={(e) => {
                          setError("");
                          setSelection((previous) => {
                            const next = { ...previous };
                            if (e.target.checked)
                              next[key] = redact(idea[key] ?? "");
                            else delete next[key];
                            return next;
                          });
                        }}
                      />
                      {fieldLabels[key]}
                    </label>
                  ))}
                </div>
                {selectedFields
                  .filter((key) => key in selection)
                  .map((key) => (
                    <label className="rt-field" key={key}>
                      {fieldLabels[key]}
                      <textarea
                        rows={3}
                        maxLength={3000}
                        value={selection[key]}
                        onChange={(e) =>
                          setSelection((previous) => ({
                            ...previous,
                            [key]: e.target.value,
                          }))
                        }
                      />
                    </label>
                  ))}
                <div className="rt-brief-columns">
                  <label className="rt-field">
                    What would success look like?
                    <span>A concrete outcome, audience and time horizon.</span>
                    <textarea
                      rows={4}
                      maxLength={1500}
                      placeholder="For example: Help 20 independent makers save an hour a week within three months."
                      value={criteria}
                      onChange={(e) => setCriteria(e.target.value)}
                    />
                  </label>
                  <label className="rt-field">
                    What are you working with?
                    <span>Time, budget, skills and important constraints.</span>
                    <textarea
                      rows={4}
                      maxLength={1500}
                      placeholder="For example: One developer, six weekends, a £300 budget, and existing tools."
                      value={constraints}
                      onChange={(e) => setConstraints(e.target.value)}
                    />
                  </label>
                </div>
              </fieldset>
              {!receipt && !uncertain && (
                <div className="rt-brief-footer">
                  <p>
                    <ShieldCheck size={16} />
                    One {name} request. Review exactly what leaves Idea Lab
                    before sending.
                  </p>
                  <button
                    type="button"
                    className="site-primary"
                    disabled={busy || saving || !gpt?.enabled}
                    onClick={prepare}
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="rt-spin" />
                    ) : (
                      <Sparkles size={15} />
                    )}
                    Review {name} request <ArrowRight size={15} />
                  </button>
                </div>
              )}
              <div className="rt-file-actions">
                <input
                  type="file"
                  ref={file}
                  className="rt-visually-hidden"
                  accept="application/json,.json"
                  onChange={(e) => void restore(e.target.files?.[0])}
                />
                <button
                  type="button"
                  className="text-link"
                  disabled={locked}
                  onClick={() => file.current?.click()}
                >
                  <Upload size={14} />
                  Load private result
                </button>
                {result && (
                  <button
                    type="button"
                    className="text-link"
                    onClick={download}
                  >
                    <Download size={14} />
                    Download {name} result
                  </button>
                )}
              </div>
            </section>
            {receipt && !uncertain && (
              <section
                className="panel rt-transmission"
                aria-labelledby="rt-consent-title"
              >
                <div className="eyebrow">REVIEW BEFORE SENDING</div>
                <h2 id="rt-consent-title">
                  One independent assessment from {name}.
                </h2>
                <p>
                  Only the content below, the scoring rubric and assessment
                  instructions will be sent. No sources, attachments, idea
                  identifiers, prior scores or other reviews are sent.
                </p>
                <dl>
                  <div>
                    <dt>Destination</dt>
                    <dd>
                      {receipt.profile.endpoint}
                      {receipt.profile.provider === "anthropic-messages"
                        ? "messages"
                        : "responses"}
                    </dd>
                  </div>
                  <div>
                    <dt>Configured model</dt>
                    <dd>{receipt.profile.deployment}</dd>
                  </div>
                  <div>
                    <dt>Limits</dt>
                    <dd>
                      One request · up to{" "}
                      {receipt.profile.maxOutputTokens.toLocaleString()} output
                      tokens · {receipt.profile.requestsPerHour} AI
                      requests/hour ·{" "}
                      {Math.round(receipt.profile.timeoutMs / 1000)}s deadline.
                      Provider charges may apply.
                    </dd>
                  </div>
                  <div>
                    <dt>Scoring</dt>
                    <dd>
                      Viability v1 · feasibility, success and value · 0–100 ·
                      equal weights. Missing evidence can leave a score unknown.
                    </dd>
                  </div>
                  <div>
                    <dt>Retention</dt>
                    <dd>
                      {receipt.profile.retentionNotice}
                      <br />
                      {receipt.profile.requestStorage}
                      <br />
                      Completed reports, their selected brief and model
                      provenance are automatically saved to Notion. The server
                      ledger stores request status and hashes only.
                    </dd>
                  </div>
                  <div>
                    <dt>Approval expires</dt>
                    <dd>{new Date(receipt.expiresAt).toLocaleString()}</dd>
                  </div>
                </dl>
                <h3>Exact selected content</h3>
                <pre>
                  {JSON.stringify(
                    {
                      selectedEvidence: receipt.command.selection,
                      successCriteria: receipt.command.successCriteria,
                      constraints: receipt.command.constraints,
                    },
                    null,
                    2,
                  )}
                </pre>
                <p>
                  {name}’s completed assessment will be automatically saved to
                  Notion. There is no extra save step. Idea text and active
                  ranking remain unchanged; peer discussion comes later.
                </p>
                <div className="action-row">
                  <button
                    type="button"
                    className="site-secondary"
                    disabled={busy}
                    onClick={() => setReceipt(null)}
                  >
                    <X size={15} />
                    Back to brief
                  </button>
                  <button
                    type="button"
                    className="site-primary"
                    disabled={busy}
                    onClick={send}
                  >
                    {busy ? (
                      <LoaderCircle size={15} className="rt-spin" />
                    ) : (
                      <ShieldCheck size={15} />
                    )}{" "}
                    {busy
                      ? `${name} is reviewing & saving…`
                      : `Approve & send to ${name}`}
                  </button>
                </div>
              </section>
            )}
          </>
        )}
      </details>
      {uncertain && (
        <section className="panel rt-transmission">
          <h2>Let’s check this request.</h2>
          <p>
            It may have been processed or charged. Checking its status does not
            contact the reviewer or send it again. After a reload, use Settings
            → Recent saves.
          </p>
          <button
            type="button"
            className="site-secondary"
            disabled={busy}
            onClick={checkStatus}
          >
            <RefreshCw size={14} />
            {busy ? "Checking…" : "Check request status"}
          </button>
          {checked && (
            <>
              <p>
                No saved result was found for this request. A fresh request
                needs a new content review and may incur another charge.
              </p>
              <button
                type="button"
                className="site-secondary"
                disabled={busy}
                onClick={() => {
                  setUncertain(false);
                  setReceipt(null);
                  setChecked(false);
                  setError("");
                  setMessage(
                    "Review a fresh request below. This will not recover or replay the earlier result.",
                  );
                }}
              >
                Review a new {name} request
              </button>
            </>
          )}
        </section>
      )}
      {error && (
        <p role="alert" className="rt-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="rt-notice">
          {message}
        </p>
      )}
      <footer className="rt-roadmap">
        <span>
          <UsersRound size={17} /> BUILT FOR MORE PERSPECTIVES
        </span>
        <p>
          Connect GPT and Claude for independent reviews. Grok and GitHub
          Copilot are next. Each will bring an independent view before reviewing
          the others.
        </p>
      </footer>
    </div>
  );
}
