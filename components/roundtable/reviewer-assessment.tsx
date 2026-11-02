"use client";
import { useState } from "react";
import { Download, ChevronDown } from "lucide-react";
import {
  reviewerName,
  dimensions,
  labels,
  provisionalScore,
  type RoundtableResult,
} from "@/lib/roundtable/model";
export function ReviewerAssessment({
  result,
  restored,
  onDownload,
}: {
  result: RoundtableResult;
  restored: boolean;
  onDownload: () => void;
}) {
  const [section, setSection] = useState("overview");
  const name = reviewerName(result.participant);
  const assessment = result.assessment,
    score = provisionalScore(assessment);
  const sections = [
    { id: "overview", label: "Overview" },
    { id: "risks", label: "Risks" },
    { id: "expansions", label: "Expand" },
    { id: "experiments", label: "Test next" },
  ];
  return (
    <div className="rt-agent-assessment">
      <div className="rt-agent-summary">
        <span>
          <strong>
            {score ?? "—"}
            <small>/100</small>
          </strong>
          <small>Provisional overall</small>
        </span>
        <span>
          <strong>
            {Math.round(assessment.confidence * 100)}
            <small>%</small>
          </strong>
          <small>Confidence</small>
        </span>
      </div>
      <h3 className="rt-agent-scores-title">
        {name}’s scores <small>Click a score for its evidence</small>
      </h3>
      <div
        className="rt-agent-ratings"
        aria-label={name + "’s viability scores"}
      >
        {dimensions.map((key) => {
          const rating = assessment.ratings[key];
          return (
            <details key={key}>
              <summary>
                <span>{labels[key]}</span>
                <strong>
                  {rating.score ?? "—"}
                  <small>/100</small>
                </strong>
                <ChevronDown size={14} />
                <span
                  className={"rt-rating-track rt-rating-" + key}
                  aria-hidden="true"
                >
                  <i style={{ width: (rating.score ?? 0) + "%" }} />
                </span>
              </summary>
              <p>{rating.evidence}</p>
            </details>
          );
        })}
      </div>
      <p className="rt-agent-score-note">
        Equal weights · unknown scores stay unranked. Success is a judgement,
        not a probability.
      </p>
      {restored && (
        <p className="rt-agent-score-note">
          Imported result · provider provenance is unverified.
        </p>
      )}
      <div
        className="rt-report-switcher"
        role="group"
        aria-label={name + " assessment sections"}
      >
        {sections.map((tab) => (
          <button
            type="button"
            key={tab.id}
            aria-pressed={section === tab.id}
            aria-controls="rt-agent-report-section"
            onClick={() => setSection(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="rt-agent-report-section"
        className="rt-agent-report-section"
        role="region"
        aria-label={sections.find((tab) => tab.id === section)!.label}
      >
        {section === "overview" ? (
          <>
            <h3>{assessment.verdict}</h3>
            <p>{assessment.summary}</p>
            <h4>What’s working</h4>
            <ul>
              {assessment.strengths.map((text, n) => (
                <li key={n}>{text}</li>
              ))}
            </ul>
            <h4>What needs proving</h4>
            <ul>
              {assessment.assumptions.map((text, n) => (
                <li key={n}>{text}</li>
              ))}
            </ul>
          </>
        ) : section === "risks" ? (
          <>
            <h3>Where it could break</h3>
            <ul>
              {assessment.risks.map((text, n) => (
                <li key={n}>{text}</li>
              ))}
            </ul>
          </>
        ) : section === "expansions" ? (
          <>
            <h3>Room to grow</h3>
            <ul>
              {assessment.expansions.map((text, n) => (
                <li key={n}>{text}</li>
              ))}
            </ul>
          </>
        ) : (
          <>
            <h3>The next small experiments</h3>
            <ol>
              {assessment.experiments.map((test, n) => (
                <li key={n}>
                  <p>{test.experiment}</p>
                  <p>
                    <strong>Look for:</strong> {test.successSignal}
                  </p>
                </li>
              ))}
            </ol>
          </>
        )}
      </div>
      <details className="rt-agent-provenance">
        <summary>Model & assessed brief</summary>
        <p>
          {result.resolvedModel} ·{" "}
          {new Date(result.completedAt).toLocaleString()}
        </p>
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
      <button type="button" className="site-secondary" onClick={onDownload}>
        <Download size={14} />
        Download {name} report
      </button>
      <p className="rt-agent-score-note">
        These provisional report scores do not replace your idea’s active
        ranking. Panel consensus follows cross-review.
      </p>
    </div>
  );
}
