"use client";
import Link from "@/components/navigation-link";
import { ArrowUpRight, Lightbulb, Link2 } from "lucide-react";
import type { Idea } from "@/lib/ideas/domain";
export function IdeaCard({ idea }: { idea: Idea }) {
  return (
    <Link className="idea-card" href={"/ideas/" + idea.id}>
      <div className="card-top">
        <span className="category-icon">
          <Lightbulb size={20} />
        </span>
        <span className={"badge " + idea.status.toLowerCase()}>
          {idea.status}
        </span>
      </div>
      <div className="card-category">{idea.category}</div>
      <h3>
        {idea.title || "Untitled record"}
        <ArrowUpRight size={16} />
      </h3>
      <p>{idea.summary || "No summary saved yet."}</p>
      <div className="card-bottom">
        <span>
          <Link2 size={13} />
          {idea.sources.length
            ? Array.from(new Set(idea.sources.map((s) => s.system))).join(", ")
            : "No linked source"}
        </span>
        <span
          className="score"
          title={
            idea.roundtableScore?.status === "ready"
              ? "Provisional roundtable Potential score"
              : "No current roundtable score"
          }
        >
          {idea.priorityScore ?? "—"}
          <small>/100</small>
        </span>
      </div>
    </Link>
  );
}
