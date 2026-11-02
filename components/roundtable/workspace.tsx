"use client";
import { useRef, useState } from "react";
import Link from "@/components/navigation-link";
import { useRouter } from "next/navigation";
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Circle,
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
  provisionalScore,
  requestSchema,
  resultSchema,
  rubricVersion,
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
type Status = {
  gpt: { enabled: boolean; profile?: Profile; message?: string };
};
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
    initial: "G",
    description: "A fresh perspective, grounded in your brief.",
    color: "mint",
  },
  {
    id: "claude",
    name: "Claude",
    initial: "C",
    description: "Another perspective on the assumptions and opportunities.",
    color: "sand",
  },
  {
    id: "grok",
    name: "Grok",
    initial: "G",
    description:
      "Another voice to challenge the idea and surface alternatives.",
    color: "blue",
  },
  {
    id: "copilot",
    name: "GitHub Copilot",
    initial: "⌘",
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
  const [selected, setSelected] = useState("gpt"),
    [selection, setSelection] = useState<
      Partial<Record<(typeof selectedFields)[number], string>>
    >({}),
    [criteria, setCriteria] = useState(""),
    [constraints, setConstraints] = useState("");
  const [busy, setBusy] = useState(false),
    [receipt, setReceipt] = useState<Receipt | null>(null),
    [result, setResult] = useState<RoundtableResult | null>(null),
    [error, setError] = useState(""),
    [message, setMessage] = useState(""),
    [uncertain, setUncertain] = useState(false),
    [checked, setChecked] = useState(false),
    [restored, setRestored] = useState(false);
  const guard = useRef(false),
    file = useRef<HTMLInputElement>(null);
  const locked = busy || !!receipt || uncertain;
  const gpt = profile.data?.gpt,
    seat = seats.find((s) => s.id === selected)!;
  function state(id: string) {
    return id !== "gpt"
      ? "Coming next"
      : busy && receipt
        ? "Reviewing…"
        : result
          ? "Assessment ready"
          : uncertain
            ? "Check request"
            : gpt?.enabled
              ? "Ready to review"
              : profile.error
                ? "Connection unavailable"
                : !profile.data
                  ? "Checking connection…"
                  : "Connection needed";
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
        await requestData<Receipt>("/api/roundtable/prepare", {
          method: "POST",
          body: JSON.stringify(command.data),
        }),
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
    setRestored(false);
    try {
      const response = await requestData<{ result: RoundtableResult }>(
        "/api/roundtable/commit",
        {
          method: "POST",
          body: JSON.stringify({
            command: receipt.command,
            approvalToken: receipt.approvalToken,
          }),
        },
      );
      setResult(resultSchema.parse(response.result));
      setReceipt(null);
      setSelected("gpt");
      setMessage(
        "GPT’s independent assessment is ready. No idea or saved score was changed.",
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
      const response = await requestData<{ status: string; message: string }>(
        "/api/roundtable/request-status",
        {
          method: "POST",
          body: JSON.stringify({ approvalToken: receipt.approvalToken }),
        },
      );
      setMessage(response.message);
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
    a.download = "idea-lab-gpt-assessment.json";
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
      setRestored(true);
      setSelected("gpt");
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
  const score = result ? provisionalScore(result.assessment) : null;
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
          GPT · first reviewer
        </span>
      </header>
      <ol className="rt-stages" aria-label="Review stages">
        <li aria-current="step">
          <span className="rt-stage-number">01</span>
          <div>
            <strong>Independent perspectives</strong>
            <small>Start with GPT’s own assessment</small>
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
      <div className="rt-layout">
        <section
          className="panel rt-table-panel"
          aria-labelledby="rt-table-title"
        >
          <div className="rt-section-label">
            <span>
              <UsersRound size={17} /> YOUR REVIEW PANEL
            </span>
            <small>One seat connected at a time</small>
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
                onClick={() => setSelected(s.id)}
                aria-pressed={selected === s.id}
                aria-label={s.name + ": " + state(s.id)}
              >
                <span className={"rt-avatar " + s.color}>
                  {s.initial}
                  {s.id === "gpt" && result && <CheckCircle2 size={15} />}
                </span>
                <strong>{s.name}</strong>
                <small>
                  <i
                    className={s.id === "gpt" && gpt?.enabled ? "ready" : ""}
                  />
                  {state(s.id)}
                </small>
              </button>
            ))}
          </div>
          <div className="rt-table-caption">
            <ShieldCheck size={15} />
            <p>
              Independent thinking first. Shared perspectives next.
              <br />
              Every opinion stays attributed to its reviewer.
            </p>
          </div>
        </section>
        <aside
          className="panel rt-reviewer-panel"
          aria-label="Selected reviewer"
        >
          <div className="rt-section-label">
            <span>AT THIS SEAT</span>
            <span className={"rt-chip " + (selected === "gpt" ? "active" : "")}>
              {selected === "gpt" ? "FIRST REVIEWER" : "COMING NEXT"}
            </span>
          </div>
          <span className={"rt-avatar rt-inspector-avatar " + seat.color}>
            {seat.initial}
          </span>
          <h2>{seat.name}</h2>
          <p>{seat.description}</p>
          <div className="rt-reviewer-status">
            <span className="rt-status-dot" />
            {state(selected)}
          </div>
          {selected === "gpt" ? (
            <>
              {profile.error ? (
                <Failure error={profile.error} retry={profile.refresh} />
              ) : gpt?.enabled ? (
                <p className="rt-model-label">
                  Model <strong>{gpt.profile?.deployment}</strong>
                  <br />
                  {gpt.profile?.provider === "openai-responses"
                    ? "OpenAI Responses API"
                    : "Azure OpenAI"}
                </p>
              ) : (
                <div className="rt-connection-note">
                  <LockKeyhole size={16} />
                  <p>
                    {gpt?.message || "Checking GPT connection…"}{" "}
                    <Link href="/settings" className="text-link">
                      Open settings <ArrowUpRight size={12} />
                    </Link>
                  </p>
                </div>
              )}
              <h3>What GPT will bring</h3>
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
          ) : (
            <div className="rt-coming-note">
              <MessageSquare size={22} />
              <h3>There’s a place at the table.</h3>
              <p>
                {seat.name} will contribute a separate assessment, then review
                the other perspectives once its integration is available.
              </p>
              <button
                type="button"
                className="site-secondary"
                onClick={() => setSelected("gpt")}
              >
                Return to GPT <ArrowRight size={14} />
              </button>
            </div>
          )}
        </aside>
      </div>
      <section className="rt-scorecard" aria-label="Viability scores">
        {dimensions.map((key, n) => (
          <div key={key} className="panel rt-score">
            <span className="rt-score-icon">
              {n === 0 ? (
                <FlaskConical size={17} />
              ) : n === 1 ? (
                <Target size={17} />
              ) : (
                <Sparkles size={17} />
              )}
            </span>
            <div>
              <h3>{labels[key]}</h3>
              <p>
                {key === "feasibility"
                  ? "Can you make it happen?"
                  : key === "success"
                    ? "Can it meet your defined outcome?"
                    : "Does it solve a meaningful problem?"}
              </p>
            </div>
            <strong>
              {result?.assessment.ratings[key].score ?? "—"}
              <small>/100</small>
            </strong>
            {result && (
              <p className="rt-score-evidence">
                {result.assessment.ratings[key].evidence}
              </p>
            )}
          </div>
        ))}
      </section>
      <p className="rt-score-note">
        {result
          ? `GPT’s provisional score: ${score ?? "insufficient evidence"}${score !== null ? "/100" : ""} · Confidence: ${Math.round(result.assessment.confidence * 100)}%. `
          : "Scores appear after an assessment. "}
        Equal weight across all three dimensions. A success score is a
        judgement, not a probability. Panel consensus is not available yet.
      </p>
      {!idea ? (
        <section className="panel rt-brief">
          <div className="rt-section-label">
            <span>START WITH A POSSIBILITY</span>
          </div>
          <IdeaPicker />
        </section>
      ) : (
        <>
          <section className="panel rt-brief" aria-labelledby="rt-brief-title">
            <div className="section-heading">
              <div>
                <div className="eyebrow">THE IDEA BRIEF</div>
                <h2 id="rt-brief-title">
                  Good questions start with the right context.
                </h2>
                <p>
                  Choose what GPT can read. Edit or redact any excerpt before
                  reviewing the request.
                </p>
              </div>
              <Link className="text-link" href={"/ideas/" + idea.id}>
                View idea <ArrowUpRight size={14} />
              </Link>
            </div>
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
                  One GPT request. Review exactly what leaves Idea Lab before
                  sending.
                </p>
                <button
                  type="button"
                  className="site-primary"
                  disabled={busy || !gpt?.enabled}
                  onClick={prepare}
                >
                  {busy ? (
                    <LoaderCircle size={15} className="rt-spin" />
                  ) : (
                    <Sparkles size={15} />
                  )}
                  Review GPT request <ArrowRight size={15} />
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
                <button type="button" className="text-link" onClick={download}>
                  <Download size={14} />
                  Download GPT result
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
                One independent assessment from GPT.
              </h2>
              <p>
                Only the content below, the scoring rubric and assessment
                instructions will be sent. No sources, attachments, idea
                identifiers, prior scores or other reviews are sent.
              </p>
              <dl>
                <div>
                  <dt>Destination</dt>
                  <dd>{receipt.profile.endpoint}responses</dd>
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
                    tokens · {receipt.profile.requestsPerHour} AI requests/hour
                    · {Math.round(receipt.profile.timeoutMs / 1000)}s deadline.
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
                    Results remain in this browser until you download them. The
                    server ledger stores request status and hashes only.
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
                No Notion record, idea text or active ranking will change. This
                first release returns GPT’s independent assessment; peer
                discussion comes later.
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
                  {busy ? "GPT is reviewing…" : "Approve & send to GPT"}
                </button>
              </div>
            </section>
          )}
        </>
      )}
      {uncertain && (
        <section className="panel rt-transmission">
          <h2>Let’s check this request.</h2>
          <p>
            It may have been processed or charged. Checking its status does not
            contact GPT or send it again. After a reload, use Settings → Recent
            saves.
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
                Completed results cannot be recovered from the ledger. A fresh
                request needs a new content review and may incur another charge.
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
                Review a new GPT request
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
      {result && (
        <section className="panel rt-report" aria-labelledby="rt-report-title">
          <div className="section-heading">
            <div>
              <div className="eyebrow">GPT’S INDEPENDENT PERSPECTIVE</div>
              <h2 id="rt-report-title">{result.assessment.verdict}</h2>
              <p>
                {result.resolvedModel} ·{" "}
                {new Date(result.completedAt).toLocaleString()} ·{" "}
                {restored
                  ? "Imported file · unverified provenance"
                  : "Generated in this session"}
              </p>
            </div>
            <button type="button" className="site-secondary" onClick={download}>
              <Download size={15} />
              Download report
            </button>
          </div>
          <p className="rt-report-summary">{result.assessment.summary}</p>
          <details className="rt-assessed-brief">
            <summary>Brief GPT assessed</summary>
            <pre>
              {JSON.stringify(
                {
                  selectedEvidence: result.input.selection,
                  successCriteria: result.input.successCriteria,
                  constraints: result.input.constraints,
                },
                null,
                2,
              )}
            </pre>
          </details>
          <div className="rt-report-columns">
            {(
              [
                {
                  key: "strengths",
                  title: "What’s working",
                  icon: CheckCircle2,
                },
                { key: "risks", title: "Where it could break", icon: Target },
                {
                  key: "assumptions",
                  title: "What needs proving",
                  icon: Circle,
                },
                { key: "expansions", title: "Room to grow", icon: Sparkles },
              ] as const
            ).map((group) => (
              <section key={group.key}>
                <h3>
                  <group.icon size={16} />
                  {group.title}
                </h3>
                <ul>
                  {result.assessment[group.key].map((text, n) => (
                    <li key={n}>{text}</li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <div className="rt-experiments">
            <h3>
              <FlaskConical size={17} />
              The next small experiments
            </h3>
            {result.assessment.experiments.map((test, n) => (
              <div key={n}>
                <span>{String(n + 1).padStart(2, "0")}</span>
                <p>
                  {test.experiment}
                  <small>
                    <strong>Look for:</strong> {test.successSignal}
                  </small>
                </p>
              </div>
            ))}
          </div>
          <p className="rt-score-note">
            Keep this download private. This assessment has not been saved to
            Notion or applied to your idea. The full panel ranking will follow
            when cross-review is implemented.
          </p>
        </section>
      )}
      <footer className="rt-roadmap">
        <span>
          <UsersRound size={17} /> BUILT FOR MORE PERSPECTIVES
        </span>
        <p>
          GPT first. Claude, Grok and GitHub Copilot next. Each will bring an
          independent view before reviewing the others.
        </p>
      </footer>
    </div>
  );
}
