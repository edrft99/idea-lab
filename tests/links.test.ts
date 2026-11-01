import { describe, it, expect, vi } from "vitest";
import { LinkRepository } from "../lib/links/repository";
import { LinkService } from "../lib/links/service";
import { Operations, digest } from "../lib/ideas/operations";
import { linkCommandSchema } from "../lib/links/model";
import { ReviewRepository } from "../lib/reviews/repository";
import { memoryDB, config, idea, ids, page, props, schema } from "./fixtures";
const otherId = "70000000-0000-4000-8000-000000000007",
  existingId = "80000000-0000-4000-8000-000000000008",
  journalId = "90000000-0000-4000-8000-000000000009";
const rich = (content: string) => ({
  type: "rich_text",
  rich_text: [{ plain_text: content }],
});
function setup() {
  const m = memoryDB(),
    ops = new Operations(m.db);
  const a = page(),
    b = page({ id: otherId });
  a.properties["Related Ideas"].relation = [{ id: existingId }];
  b.properties.Title.title = [{ plain_text: "Synthetic companion" }];
  const pages = new Map([
    [ids.idea, a],
    [otherId, b],
  ]);
  const ip = schema().properties as Record<string, any>;
  ip["Related Ideas"].relation = {
    type: "single_property",
    data_source_id: ids.ideas,
    single_property: {},
  };
  const names: Record<string, string> = {};
  for (const [name, p] of Object.entries(ip)) names[p.id] = name;
  const rp: Record<string, any> = {};
  for (const name of [
    "Name",
    "Review Type",
    "Candidate Idea",
    "Potential Matching Idea",
    "Status",
    "Reviewer Decision",
    "Reviewed Date",
    "Reviewer",
    "Candidate Revision",
    "Match Revision",
    "Pair Key",
    "Proposal Payload",
    "Classification Version",
    "Approval Hash",
    "Operation ID",
    "Reasoning",
    "Similarity Score",
    "AI Recommendation",
    "Embedding Version",
  ]) {
    const type =
      name === "Similarity Score"
        ? "number"
        : name === "AI Recommendation"
          ? "select"
          : name === "Name"
            ? "title"
            : ["Review Type", "Status"].includes(name)
              ? "select"
              : ["Candidate Idea", "Potential Matching Idea"].includes(name)
                ? "relation"
                : name === "Reviewed Date"
                  ? "date"
                  : "rich_text";
    rp[name] = { id: "r" + Object.keys(rp).length, type };
    names[rp[name].id] = name;
  }
  let journal: any = null,
    tick = 0;
  const writes: { id: string; names: string[] }[] = [];
  const faults = {
    lostJournal: false,
    denySecond: false,
    lostFirst: false,
    lostSecond: false,
  };
  const request = vi.fn(async (url: any, init: any = {}) => {
    const u = new URL(String(url)),
      p = u.pathname.replace("/v1/", ""),
      method = init.method ?? "GET",
      body = init.body ? JSON.parse(init.body) : {};
    if (p === "data_sources/" + ids.ideas)
      return Response.json({ properties: ip });
    if (p === "data_sources/" + ids.reviews)
      return Response.json({ properties: rp });
    if (p === "data_sources/" + ids.sources + "/query")
      return Response.json({ results: [], has_more: false });
    if (p === "data_sources/" + ids.reviews + "/query")
      return Response.json({
        results: journal ? [journal] : [],
        has_more: false,
      });
    if (p.startsWith("pages/") && method === "GET")
      return Response.json(pages.get(p.slice(6)) ?? journal, {
        status: pages.has(p.slice(6)) || journal?.id === p.slice(6) ? 200 : 404,
      });
    const decode = (properties: Record<string, any>) =>
      Object.fromEntries(
        Object.entries(properties).map(([key, v]) => [
          names[key],
          { ...v, id: key, type: rp[names[key]]?.type ?? ip[names[key]]?.type },
        ]),
      );
    if (p === "pages" && method === "POST") {
      journal = page({
        id: journalId,
        parent: { type: "data_source_id", data_source_id: ids.reviews },
        properties: decode(body.properties),
      });
      writes.push({ id: journalId, names: Object.keys(journal.properties) });
      if (faults.lostJournal) {
        faults.lostJournal = false;
        throw new Error("Synthetic lost journal response");
      }
      return Response.json(journal);
    }
    if (p.startsWith("pages/") && method === "PATCH") {
      const id = p.slice(6),
        target = pages.get(id)!;
      if (id === otherId && faults.denySecond)
        return Response.json({ code: "restricted_resource" }, { status: 403 });
      const values = decode(body.properties);
      writes.push({ id, names: Object.keys(values) });
      Object.assign(target.properties, values);
      target.last_edited_time =
        "2026-10-30T12:00:" + String(++tick).padStart(2, "0") + ".000Z";
      if (id === ids.idea && faults.lostFirst) {
        faults.lostFirst = false;
        return new Response("unreadable", { status: 200 });
      }
      if (id === otherId && faults.lostSecond) {
        faults.lostSecond = false;
        return new Response("unreadable", { status: 200 });
      }
      return Response.json(target);
    }
    throw new Error("Unexpected synthetic request " + method + " " + p);
  });
  const repo = new LinkRepository(config, request as typeof fetch),
    svc = new LinkService(repo, ops);
  const command = linkCommandSchema.parse({
    candidateId: ids.idea,
    matchingId: otherId,
    candidateRevision: idea.revision,
    matchingRevision: idea.revision,
    reason: "Share reusable components while keeping separate goals.",
  });
  return {
    m,
    ops,
    a,
    b,
    repo,
    svc,
    command,
    writes,
    faults,
    ip,
    request,
    get journal() {
      return journal;
    },
  };
}
describe("explicit related links", () => {
  it("rejects self pairs and unreviewed merge fields", () => {
    const s = setup();
    try {
      expect(
        linkCommandSchema.safeParse({
          ...s.command,
          matchingId: ids.idea.toUpperCase(),
        }).success,
      ).toBe(false);
      expect(
        linkCommandSchema.safeParse({ ...s.command, merge: true }).success,
      ).toBe(false);
    } finally {
      s.m.close();
    }
  });
  it("previews without writes, preserves content/scores/history and links both ways exactly once", async () => {
    const s = setup();
    try {
      s.a.properties.Impact.number = 5;
      s.a.properties["Score Authority"].select = { name: "manual" };
      const before = structuredClone(s.a.properties);
      const receipt = await s.svc.prepare(s.command, "owner");
      expect(s.writes).toHaveLength(0);
      expect(receipt.changes[0].after).toContain(existingId);
      await s.svc.execute(s.command, receipt.approvalToken, "owner");
      expect(s.writes.map((w) => w.id)).toEqual([journalId, ids.idea, otherId]);
      for (const w of s.writes.filter((w) => w.id !== journalId))
        expect(w.names.sort()).toEqual([
          "Approved At",
          "Approved By",
          "Record Version",
          "Related Ideas",
        ]);
      for (const [name, value] of Object.entries(before))
        if (
          ![
            "Approved At",
            "Approved By",
            "Record Version",
            "Related Ideas",
          ].includes(name)
        )
          expect(s.a.properties[name]).toEqual(value);
      expect(
        s.a.properties["Related Ideas"].relation.map((x: any) => x.id),
      ).toEqual([otherId, existingId].sort());
      expect(s.b.properties["Related Ideas"].relation).toEqual([
        { id: ids.idea },
      ]);
      expect(
        (await s.svc.execute(s.command, receipt.approvalToken, "owner"))
          .replayed,
      ).toBe(true);
      expect(s.writes).toHaveLength(3);
      expect(
        (await s.svc.reconcileToken(receipt.approvalToken, "owner")).status,
      ).toBe("done");
    } finally {
      s.m.close();
    }
  });
  it("binds actor, payload and both original revisions", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      await expect(
        s.svc.execute(s.command, r.approvalToken, "someone"),
      ).rejects.toMatchObject({ code: "INVALID_APPROVAL" });
      await expect(
        s.svc.execute(
          { ...s.command, reason: "Changed" },
          r.approvalToken,
          "owner",
        ),
      ).rejects.toMatchObject({ code: "APPROVAL_CHANGED" });
      s.b.last_edited_time = "changed";
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ code: "STALE_IDEA" });
      expect(s.writes).toHaveLength(0);
      expect((await s.ops.read(r.approvalToken, "owner")).status).toBe(
        "failed",
      );
    } finally {
      s.m.close();
    }
  });
  it("rejects superseded, already linked and unsupported self-relation schemas before writing", async () => {
    const s = setup();
    try {
      s.a.properties["Canonical Idea"].relation = [{ id: existingId }];
      await expect(s.svc.prepare(s.command, "owner")).rejects.toMatchObject({
        code: "SUPERSEDED_IDEA",
      });
      s.a.properties["Canonical Idea"].relation = [];
      s.a.properties["Related Ideas"].relation = [{ id: otherId }];
      s.b.properties["Related Ideas"].relation = [{ id: ids.idea }];
      await expect(s.svc.prepare(s.command, "owner")).rejects.toMatchObject({
        code: "ALREADY_LINKED",
      });
      s.ip["Related Ideas"].relation.type = "dual_property";
      await expect(s.svc.prepare(s.command, "owner")).rejects.toMatchObject({
        code: "LINK_SCHEMA_UNSUPPORTED",
      });
      expect(s.writes).toHaveLength(0);
    } finally {
      s.m.close();
    }
  });
  it("recovers a lost first patch response without replaying that patch", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.lostFirst = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const op = await s.ops.read(r.approvalToken, "owner");
      expect(await s.svc.reconcile(op.id, "owner")).toMatchObject({
        status: "uncertain",
        canResume: true,
        completedSides: 1,
      });
      expect(s.writes).toHaveLength(2);
      await s.svc.resume(op.id, "owner");
      expect(s.writes.map((w) => w.id)).toEqual([journalId, ids.idea, otherId]);
      expect((await s.ops.read(r.approvalToken, "owner")).status).toBe("done");
    } finally {
      s.m.close();
    }
  });
  it("resumes a confirmed journal after its creation response was lost", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.lostJournal = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const op = await s.ops.read(r.approvalToken, "owner");
      expect(await s.svc.reconcile(op.id, "owner")).toMatchObject({
        canResume: true,
        completedSides: 0,
      });
      await s.svc.resume(op.id, "owner");
      expect(s.writes.filter((w) => w.id === journalId)).toHaveLength(1);
    } finally {
      s.m.close();
    }
  });
  it("status alone resolves both accepted patches after a lost second response", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.lostSecond = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const writes = s.writes.length;
      expect(
        await s.svc.reconcileToken(r.approvalToken, "owner"),
      ).toMatchObject({ status: "done" });
      expect(s.writes).toHaveLength(writes);
    } finally {
      s.m.close();
    }
  });
  it("retains locks after a denied second patch and prevents a competing edit", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.denySecond = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const competing = await s.ops.issue(
        "owner",
        "hash",
        "update",
        otherId,
        "revision",
      );
      await expect(
        s.ops.claim(await s.ops.read(competing.token, "owner"), "hash"),
      ).rejects.toMatchObject({ code: "SAVE_BUSY" });
      s.faults.denySecond = false;
      await s.svc.resume(
        (await s.ops.read(r.approvalToken, "owner")).id,
        "owner",
      );
      expect(s.writes).toHaveLength(3);
    } finally {
      s.m.close();
    }
  });
  it("preserves an external edit after partial save and refuses recovery", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.denySecond = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      s.b.properties.Summary = rich("New external description");
      const before = s.writes.length,
        op = await s.ops.read(r.approvalToken, "owner");
      await expect(s.svc.reconcile(op.id, "owner")).rejects.toMatchObject({
        code: "LINK_CONFLICT",
      });
      await expect(s.svc.resume(op.id, "owner")).rejects.toMatchObject({
        code: "LINK_CONFLICT",
      });
      expect(s.writes).toHaveLength(before);
      expect(s.b.properties.Summary.rich_text[0].plain_text).toBe(
        "New external description",
      );
    } finally {
      s.m.close();
    }
  });
  it("rejects a tampered journal even when its command and operation marker match", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.denySecond = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const journal = JSON.parse(
        s.journal.properties["Proposal Payload"].rich_text
          .map((x: any) => x.text.content)
          .join(""),
      );
      journal.before[1].related = [existingId];
      s.journal.properties["Proposal Payload"] = rich(JSON.stringify(journal));
      await expect(
        s.svc.resume((await s.ops.read(r.approvalToken, "owner")).id, "owner"),
      ).rejects.toMatchObject({ code: "RECONCILIATION_REQUIRED" });
    } finally {
      s.m.close();
    }
  });
  it("permits only one concurrent recovery claim and requires all original locks", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      s.faults.denySecond = true;
      await expect(
        s.svc.execute(s.command, r.approvalToken, "owner"),
      ).rejects.toMatchObject({ uncertain: true });
      const op = await s.ops.read(r.approvalToken, "owner");
      const settled = await Promise.allSettled([
        s.ops.resume(op, [ids.idea, otherId]),
        s.ops.resume(op, [ids.idea, otherId]),
      ]);
      expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(settled.filter((r) => r.status === "rejected")).toHaveLength(1);
      await s.ops.finish(op.id, "uncertain");
      await s.m.db
        .prepare("DELETE FROM idea_lab_operation_locks WHERE target=?")
        .bind(otherId)
        .run();
      await expect(s.svc.resume(op.id, "owner")).rejects.toMatchObject({
        code: "RECONCILIATION_REQUIRED",
      });
    } finally {
      s.m.close();
    }
  });
  it("keeps approved link journals out of classification/rejection history", async () => {
    const s = setup();
    try {
      const r = await s.svc.prepare(s.command, "owner");
      await s.svc.execute(s.command, r.approvalToken, "owner");
      const reviewRepo = new ReviewRepository(
        config,
        s.request as typeof fetch,
      );
      expect(
        (await reviewRepo.context(ids.idea, otherId)).history,
      ).toHaveLength(0);
      await expect(reviewRepo.review(journalId)).rejects.toMatchObject({
        code: "LINK_JOURNAL",
      });
    } finally {
      s.m.close();
    }
  });
});
