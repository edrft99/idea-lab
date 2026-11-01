import { describe, it, expect, vi } from "vitest";
import { MergeRepository } from "../lib/merges/repository";
import { MergeService } from "../lib/merges/service";
import { mergeCommandSchema } from "../lib/merges/model";
import { Operations } from "../lib/ideas/operations";
import { ReviewRepository } from "../lib/reviews/repository";
import { IdeaService } from "../lib/ideas/service";
import { EvaluationService } from "../lib/evaluations/service";
import { lineageIds } from "../lib/ideas/lineage";
import { memoryDB, config, ids, idea, input, page, schema } from "./fixtures";
const firstId = "70000000-0000-4000-8000-000000000007",
  secondId = "80000000-0000-4000-8000-000000000008",
  journalId = "90000000-0000-4000-8000-000000000009",
  childId = "a0000000-0000-4000-8000-00000000000a";
const sourceId = "b0000000-0000-4000-8000-00000000000b",
  evalId = "c0000000-0000-4000-8000-00000000000c";
const plain = (p: any) =>
  (p?.rich_text ?? p?.title ?? [])
    .map((t: any) => t.plain_text ?? t.text?.content ?? "")
    .join("");
const rich = (content: string) => ({
  type: "rich_text",
  rich_text: [{ plain_text: content }],
});
function setup() {
  const m = memoryDB(),
    ops = new Operations(m.db),
    a = page(),
    b = page({ id: firstId }),
    c = page({ id: secondId });
  b.properties.Title.title = [{ plain_text: "First synthetic original" }];
  c.properties.Title.title = [{ plain_text: "Second synthetic original" }];
  a.properties.Impact.number = 5;
  a.properties["Priority Score"].number = 92;
  a.properties["Score Authority"].select = { name: "manual-approved" };
  b.properties.Summary = rich("Keep the first original description.");
  c.properties.Summary = rich("Keep the second original description.");
  b.properties["Priority Score"].number = 25;
  const pages = new Map<string, any>([
    [ids.idea, a],
    [firstId, b],
    [secondId, c],
  ]);
  const ip = schema().properties as Record<string, any>,
    rp: Record<string, any> = {},
    ep = {
      "Related Idea": { id: "e0", type: "relation" },
      "Evaluation Date": { id: "e1", type: "date" },
    };
  for (const name of ["Related Ideas", "Canonical Idea"])
    ip[name].relation = {
      type: "single_property",
      data_source_id: ids.ideas,
      single_property: {},
    };
  const names: Record<string, string> = {};
  for (const [name, p] of Object.entries(ip)) names[p.id] = name;
  for (const name of [
    "Name",
    "Review Type",
    "Candidate Idea",
    "Potential Matching Idea",
    "Similarity Score",
    "AI Recommendation",
    "Reasoning",
    "Status",
    "Reviewer Decision",
    "Reviewed Date",
    "Reviewer",
    "Candidate Revision",
    "Match Revision",
    "Pair Key",
    "Proposal Payload",
    "Embedding Version",
    "Classification Version",
    "Approval Hash",
    "Operation ID",
  ]) {
    const type =
      name === "Name"
        ? "title"
        : name === "Similarity Score"
          ? "number"
          : ["Review Type", "Status", "AI Recommendation"].includes(name)
            ? "select"
            : ["Candidate Idea", "Potential Matching Idea"].includes(name)
              ? "relation"
              : name === "Reviewed Date"
                ? "date"
                : "rich_text";
    rp[name] = { id: "r" + Object.keys(rp).length, type };
    names[rp[name].id] = name;
  }
  const writes: { id: string; names: string[] }[] = [],
    attempts: string[] = [];
  let journal: any = null,
    journalBody: any = null,
    tick = 0;
  const fault = {
    target: "",
    mode: "" as "" | "deny" | "lost",
    journalLost: false,
  };
  const queryMatch = (row: any, filter: any): boolean => {
    if (!filter) return true;
    if (filter.or) return filter.or.some((f: any) => queryMatch(row, f));
    const p = row.properties[filter.property];
    if (filter.relation)
      return (p?.relation ?? []).some(
        (r: any) => r.id === filter.relation.contains,
      );
    if (filter.rich_text) return plain(p) === filter.rich_text.equals;
    if (filter.select) return p?.select?.name === filter.select.equals;
    return true;
  };
  const request = vi.fn(async (url: any, init: any = {}) => {
    const p = new URL(String(url)).pathname.replace("/v1/", ""),
      method = init.method ?? "GET",
      body = init.body ? JSON.parse(init.body) : {};
    if (p === "data_sources/" + ids.ideas)
      return Response.json({ properties: ip });
    if (p === "data_sources/" + ids.reviews)
      return Response.json({ properties: rp });
    if (p === "data_sources/" + ids.evaluations)
      return Response.json({ properties: ep });
    if (p === "data_sources/" + ids.sources)
      return Response.json({
        properties: {
          "Related Idea": { id: "s0", type: "relation" },
          "Source System": { id: "s1", type: "select" },
        },
      });
    if (p.endsWith("/query")) {
      const source = p.split("/")[1];
      const rows = [...pages.values(), ...(journal ? [journal] : [])].filter(
        (row) =>
          row.parent.data_source_id === source &&
          !row.in_trash &&
          queryMatch(row, body.filter),
      );
      return Response.json({ results: rows, has_more: false });
    }
    if (p.startsWith("pages/") && method === "GET") {
      const id = p.slice(6),
        row = pages.get(id) ?? (journal?.id === id ? journal : null);
      return row
        ? Response.json(row)
        : Response.json({ code: "object_not_found" }, { status: 404 });
    }
    const decode = (props: Record<string, any>) =>
      Object.fromEntries(
        Object.entries(props).map(([k, v]) => [
          names[k],
          { ...v, id: k, type: rp[names[k]]?.type ?? ip[names[k]]?.type },
        ]),
      );
    if (p === "pages" && method === "POST") {
      journalBody = body;
      journal = page({
        id: journalId,
        parent: { type: "data_source_id", data_source_id: ids.reviews },
        properties: decode(body.properties),
      });
      writes.push({ id: journalId, names: Object.keys(journal.properties) });
      if (fault.journalLost) {
        fault.journalLost = false;
        return new Response("unreadable", { status: 200 });
      }
      return Response.json(journal);
    }
    if (p.startsWith("pages/") && method === "PATCH") {
      const id = p.slice(6);
      attempts.push(id);
      if (fault.target === id && fault.mode === "deny")
        return Response.json({ code: "restricted_resource" }, { status: 403 });
      const row = pages.get(id);
      if (!row) throw new Error("Unexpected target");
      const values = decode(body.properties);
      Object.assign(row.properties, values);
      row.last_edited_time =
        "2026-10-30T12:00:" + String(++tick).padStart(2, "0") + ".000Z";
      writes.push({ id, names: Object.keys(values) });
      if (fault.target === id && fault.mode === "lost") {
        fault.mode = "";
        return new Response("unreadable", { status: 200 });
      }
      return Response.json(row);
    }
    throw new Error("Unexpected synthetic request " + method + " " + p);
  });
  const repository = new MergeRepository(config, request as typeof fetch),
    service = new MergeService(repository, ops);
  const command = mergeCommandSchema.parse({
    survivorId: ids.idea,
    survivorRevision: idea.revision,
    candidates: [
      { id: firstId, revision: idea.revision },
      { id: secondId, revision: idea.revision },
    ],
    reason: "Consolidate evidence while preserving original assessments.",
    preserveOriginals: true,
  });
  return {
    m,
    ops,
    a,
    b,
    c,
    pages,
    ip,
    repository,
    service,
    command,
    writes,
    attempts,
    fault,
    request,
    get journal() {
      return journal;
    },
    get journalBody() {
      return journalBody;
    },
  };
}
describe("explicit recoverable merges", () => {
  it("requires named distinct originals and an explicit preservation acknowledgment", () => {
    const s = setup();
    try {
      for (const bad of [
        { ...s.command, preserveOriginals: false },
        { ...s.command, candidates: [] },
        {
          ...s.command,
          candidates: [{ id: ids.idea.toUpperCase(), revision: "r" }],
        },
        {
          ...s.command,
          candidates: [s.command.candidates[0], s.command.candidates[0]],
        },
        { ...s.command, deleteOriginals: true },
      ])
        expect(mergeCommandSchema.safeParse(bad).success).toBe(false);
    } finally {
      s.m.close();
    }
  });
  it("previews all participants, then preserves originals/scores and journals exact snapshots", async () => {
    const s = setup();
    try {
      const originals = [s.a, s.b, s.c].map((p) =>
        structuredClone(p.properties),
      );
      const receipt = await s.service.prepare(s.command, "owner");
      expect(s.writes).toHaveLength(0);
      expect(receipt.changes[0].after).toContain(ids.idea);
      expect(
        receipt.changes.filter((c) => c.field.startsWith("Preserved original")),
      ).toHaveLength(2);
      await s.service.execute(s.command, receipt.approvalToken, "owner");
      expect(s.writes.map((w) => w.id)).toEqual([
        journalId,
        ids.idea,
        firstId,
        secondId,
      ]);
      expect(s.a.properties["Priority Score"].number).toBe(92);
      expect(s.a.properties["Related Ideas"].relation).toEqual([
        { id: firstId },
        { id: secondId },
      ]);
      for (const [n, p] of [s.a, s.b, s.c].entries()) {
        const touched = [
          "Approved At",
          "Approved By",
          "Record Version",
          ...(n === 0 ? ["Related Ideas"] : ["Status", "Canonical Idea"]),
        ];
        for (const [name, value] of Object.entries(originals[n]))
          if (!touched.includes(name))
            expect(p.properties[name]).toEqual(value);
        if (n > 0) {
          expect(p.properties.Status.select.name).toBe("Archived");
          expect(p.properties["Canonical Idea"].relation).toEqual([
            { id: ids.idea },
          ]);
        }
      }
      const snapshot = s.journalBody.children[2].code.rich_text
        .map((t: any) => t.text.content)
        .join("");
      expect(JSON.parse(snapshot).description.summary).toBe(
        "Keep the first original description.",
      );
      expect(
        (await s.service.execute(s.command, receipt.approvalToken, "owner"))
          .replayed,
      ).toBe(true);
      expect(s.writes).toHaveLength(4);
    } finally {
      s.m.close();
    }
  });
  it("binds actor/payload and expiry; changed inputs fail before any journal write", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(s.command, "owner");
      await expect(
        s.service.execute(s.command, r.approvalToken, "another"),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      await expect(
        s.service.execute(
          { ...s.command, reason: "Changed" },
          r.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      s.c.last_edited_time = "changed";
      await expect(
        s.service.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      expect(s.writes).toHaveLength(0);
      expect((await s.ops.read(r.approvalToken, "owner")).status).toBe(
        "failed",
      );
      s.c.last_edited_time = idea.updatedAt;
      const expired = await s.service.prepare(s.command, "owner");
      await s.m.db
        .prepare("UPDATE idea_lab_operations SET expires_at=? WHERE id=?")
        .bind(0, (await s.ops.read(expired.approvalToken, "owner")).id)
        .run();
      await expect(
        s.service.execute(s.command, expired.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "APPROVAL_EXPIRED" });
    } finally {
      s.m.close();
    }
  });
  it.each([ids.idea, firstId, secondId])(
    "reconciles or resumes a lost response at %s without replaying accepted steps",
    async (target) => {
      const s = setup();
      try {
        const r = await s.service.prepare(s.command, "owner");
        s.fault.target = target;
        s.fault.mode = "lost";
        await expect(
          s.service.execute(s.command, r.approvalToken, "owner"),
        ).rejects.toMatchObject({ uncertain: true });
        const op = await s.ops.read(r.approvalToken, "owner"),
          before = s.writes.length;
        const result = await s.service.reconcile(op.id, "owner");
        if (target === secondId) {
          expect(result.status).toBe("done");
          expect(s.writes).toHaveLength(before);
        } else {
          expect(result.canResume).toBe(true);
          await s.service.resume(op.id, "owner");
        }
        expect(s.writes.map((w) => w.id)).toEqual([
          journalId,
          ids.idea,
          firstId,
          secondId,
        ]);
        expect((await s.ops.read(r.approvalToken, "owner")).status).toBe(
          "done",
        );
      } finally {
        s.m.close();
      }
    },
  );
  it("recovers accepted intent after a lost journal response without creating another journal", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(s.command, "owner");
      s.fault.journalLost = true;
      await expect(
        s.service.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const op = await s.ops.read(r.approvalToken, "owner");
      expect(await s.service.reconcile(op.id, "owner")).toMatchObject({
        completedSteps: 0,
        totalSteps: 3,
        canResume: true,
      });
      await s.service.resume(op.id, "owner");
      expect(s.writes.filter((w) => w.id === journalId)).toHaveLength(1);
    } finally {
      s.m.close();
    }
  });
  it("locks every participant through a denied candidate step, then resumes only missing steps", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(s.command, "owner");
      s.fault.target = firstId;
      s.fault.mode = "deny";
      await expect(
        s.service.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const competing = await s.ops.issue(
        "owner",
        "hash",
        "update",
        secondId,
        null,
      );
      await expect(
        s.ops.claim(await s.ops.read(competing.token, "owner"), "hash"),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      s.fault.mode = "";
      const op = await s.ops.read(r.approvalToken, "owner");
      const results = await Promise.allSettled([
        s.service.resume(op.id, "owner"),
        s.service.resume(op.id, "owner"),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(s.writes.map((w) => w.id)).toEqual([
        journalId,
        ids.idea,
        firstId,
        secondId,
      ]);
    } finally {
      s.m.close();
    }
  });
  it("stops when a manual score changes after a partial merge and never overwrites it", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(s.command, "owner");
      s.fault.target = firstId;
      s.fault.mode = "deny";
      await expect(
        s.service.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      s.c.properties["Priority Score"].number = 100;
      const before = s.writes.length;
      const op = await s.ops.read(r.approvalToken, "owner");
      await expect(s.service.reconcile(op.id, "owner")).rejects.toMatchObject({
        code: "MERGE_CONFLICT",
      });
      await expect(s.service.resume(op.id, "owner")).rejects.toMatchObject({
        code: "MERGE_CONFLICT",
      });
      expect(s.writes).toHaveLength(before);
      expect(s.c.properties["Priority Score"].number).toBe(100);
    } finally {
      s.m.close();
    }
  });
  it("refuses a tampered journal and a recovery missing a participant lock", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(s.command, "owner");
      s.fault.target = firstId;
      s.fault.mode = "deny";
      await expect(
        s.service.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const original = structuredClone(
          s.journal.properties["Proposal Payload"],
        ),
        j = JSON.parse(plain(original));
      j.before[0].related = [childId];
      s.journal.properties["Proposal Payload"] = rich(JSON.stringify(j));
      const op = await s.ops.read(r.approvalToken, "owner");
      await expect(s.service.resume(op.id, "owner")).rejects.toMatchObject({
        code: "RECONCILIATION_REQUIRED",
      });
      s.journal.properties["Proposal Payload"] = original;
      await s.m.db
        .prepare("DELETE FROM idea_lab_operation_locks WHERE target=?")
        .bind(secondId)
        .run();
      await expect(s.service.resume(op.id, "owner")).rejects.toMatchObject({
        code: "RECONCILIATION_REQUIRED",
      });
    } finally {
      s.m.close();
    }
  });
  it("rejects changed relation schemas, oversized journals and superseded inputs before mutation", async () => {
    const s = setup();
    try {
      s.ip["Canonical Idea"].relation.type = "dual_property";
      await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject(
        { code: "MERGE_SCHEMA_UNSUPPORTED" },
      );
      s.ip["Canonical Idea"].relation.type = "single_property";
      s.b.properties["Canonical Idea"].relation = [{ id: childId }];
      await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject(
        { code: "SUPERSEDED_IDEA" },
      );
      s.b.properties["Canonical Idea"].relation = [];
      s.b.properties.Summary = rich("x".repeat(120000));
      await expect(s.service.prepare(s.command, "owner")).rejects.toMatchObject(
        { code: "MERGE_SIZE_LIMIT" },
      );
      expect(s.writes).toHaveLength(0);
      expect(await s.ops.recent("owner")).toHaveLength(0);
    } finally {
      s.m.close();
    }
  });
  it("keeps merge intent separate from classification/rejection history", async () => {
    const s = setup();
    try {
      const r = await s.service.prepare(s.command, "owner");
      await s.service.execute(s.command, r.approvalToken, "owner");
      const rr = new ReviewRepository(config, s.request as typeof fetch);
      expect((await rr.context(ids.idea, firstId)).history).toHaveLength(0);
      await expect(rr.review(journalId)).rejects.toMatchObject({
        code: "LINK_JOURNAL",
      });
    } finally {
      s.m.close();
    }
  });
  it("gathers nested original sources and evaluation history without rewriting either", async () => {
    const s = setup();
    try {
      const child = page({ id: childId });
      child.properties["Canonical Idea"].relation = [{ id: firstId }];
      child.properties.Status.select = { name: "Archived" };
      child.properties.Title.title = [
        { plain_text: "Earlier preserved original" },
      ];
      s.pages.set(childId, child);
      const source = page({
        id: sourceId,
        parent: { type: "data_source_id", data_source_id: ids.sources },
        properties: {
          "Source System": { select: { name: "Codex" } },
          "Source Identifier": rich("synthetic-evidence"),
          "Extracted Summary": rich("Original evidence"),
          "Related Idea": { relation: [{ id: childId }] },
          "Original URL": { url: "https://example.test/source" },
        },
      });
      const assessment = page({
        id: evalId,
        parent: { type: "data_source_id", data_source_id: ids.evaluations },
        properties: {
          "Related Idea": { relation: [{ id: childId }] },
          "Evaluation Date": { date: { start: "2026-10-29" } },
          "Overall Score": { number: 25 },
          Authority: rich("manual-approved"),
          Rationale: rich("Original assessment"),
          "Rubric Version": rich("v1"),
        },
      });
      s.pages.set(sourceId, source);
      s.pages.set(evalId, assessment);
      const before = JSON.stringify([source, assessment]);
      const r = await s.service.prepare(s.command, "owner");
      await s.service.execute(s.command, r.approvalToken, "owner");
      const detail = await s.repository.detail(ids.idea);
      expect(detail.mergedIdeas?.map((i) => i.id)).toEqual([
        firstId,
        secondId,
        childId,
      ]);
      expect(detail.sources?.map((s) => s.id)).toEqual([sourceId]);
      expect(detail.evaluations.map((e) => e.id)).toEqual([evalId]);
      expect(detail.evaluations[0].originalIdeaIds).toEqual([childId]);
      expect(detail.idea.priorityScore).toBe(92);
      expect(detail.idea.latestEvaluationId).toBeNull();
      expect(JSON.stringify([source, assessment])).toBe(before);
      expect(
        (await s.repository.list({ source: "Codex", sort: "score" })).map(
          (i) => i.id,
        ),
      ).toEqual([ids.idea]);
      expect(
        (await s.repository.list({ status: "Archived", sort: "score" }))
          .map((i) => i.id)
          .sort(),
      ).toEqual([firstId, secondId, childId].sort());
    } finally {
      s.m.close();
    }
  });
  it("prevents ordinary edits/evaluations from changing a superseded original", async () => {
    const s = setup();
    try {
      s.b.properties["Canonical Idea"].relation = [{ id: ids.idea }];
      const edits = new IdeaService(s.repository, s.ops);
      await expect(
        edits.prepare(
          {
            action: "update",
            id: firstId,
            expectedRevision: idea.revision,
            data: input,
          },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "SUPERSEDED_IDEA" });
      const evaluations = new EvaluationService(s.repository as any, s.ops);
      const draft = {
        rubricVersion: "potential-v1",
        weights: {
          impact: 30,
          alignment: 25,
          feasibility: 20,
          reusability: 15,
          timing: 10,
        },
        ratings: {
          impact: 3,
          alignment: 3,
          feasibility: 3,
          reusability: 3,
          timing: 3,
        },
        evidence: {
          impact: "Evidence",
          alignment: "Evidence",
          feasibility: "Evidence",
          reusability: "Evidence",
          timing: "Evidence",
        },
        rationale: "Preserved assessment",
        benefits: "Reuse",
        risks: "Unknowns",
        assumptions: "Testing",
        effort: "Unknown" as const,
        readiness: "Discovery" as const,
        confidence: 0.5,
        nextAction: "Review evidence",
      };
      await expect(
        evaluations.prepare(
          {
            ideaId: firstId,
            expectedRevision: idea.revision,
            draft,
            applyToIdea: false,
            replaceManualScore: false,
            overrideReason: "",
          },
          "owner",
        ),
      ).rejects.toMatchObject({ code: "SUPERSEDED_IDEA" });
      expect(s.writes).toHaveLength(0);
    } finally {
      s.m.close();
    }
  });
});
describe("terminal operation state", () => {
  it("does not reopen a confirmed save when a delayed failure arrives", async () => {
    const m = memoryDB();
    try {
      const ops = new Operations(m.db),
        r = await ops.issue("owner", "hash", "merge-ideas", "merge:test", null);
      await ops.claim(await ops.read(r.token, "owner"), "hash");
      await ops.finish(r.id, "done", ids.idea);
      await ops.finish(r.id, "uncertain");
      await ops.finish(r.id, "failed");
      expect(await ops.read(r.token, "owner")).toMatchObject({
        status: "done",
        result_id: ids.idea,
      });
    } finally {
      m.close();
    }
  });
});
describe("bounded canonical lineage", () => {
  it("preserves transitive originals and rejects reachable cycles or oversized families", () => {
    expect(
      lineageIds(ids.idea, [
        { id: firstId, canonicalIdeaId: ids.idea },
        { id: secondId, canonicalIdeaId: firstId },
      ]),
    ).toEqual([ids.idea, firstId, secondId]);
    expect(() =>
      lineageIds(ids.idea, [
        { id: ids.idea, canonicalIdeaId: firstId },
        { id: firstId, canonicalIdeaId: ids.idea },
      ]),
    ).toThrow();
    expect(() =>
      lineageIds(ids.idea, [{ id: firstId, canonicalIdeaId: ids.idea }], 1),
    ).toThrow();
  });
});
