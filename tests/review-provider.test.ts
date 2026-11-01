import { describe, it, expect, vi } from "vitest";
import { ReviewRepository } from "../lib/reviews/repository";
import { ReviewService } from "../lib/reviews/service";
import { Operations } from "../lib/ideas/operations";
import { pairKey, decisionCommandSchema } from "../lib/reviews/model";
import { memoryDB, config, ids, idea, props, page, schema } from "./fixtures";
const matchingId = "70000000-0000-4000-8000-000000000007",
  originalId = "80000000-0000-4000-8000-000000000008",
  decisionId = "90000000-0000-4000-8000-000000000009";
async function provider(
  options: {
    legacy?: boolean;
    lostCloseResponse?: boolean;
    rejectClose?: boolean;
  } = {},
) {
  const types: Record<string, string> = {
    Name: "title",
    "Review Type": "select",
    "Candidate Idea": "relation",
    "Potential Matching Idea": "relation",
    "Similarity Score": "number",
    "AI Recommendation": "select",
    Reasoning: "rich_text",
    Status: "select",
    "Reviewer Decision": "rich_text",
    "Reviewed Date": "date",
    Reviewer: "rich_text",
    "Candidate Revision": "rich_text",
    "Match Revision": "rich_text",
    "Pair Key": "rich_text",
    "Proposal Payload": "rich_text",
    "Embedding Version": "rich_text",
    "Classification Version": "rich_text",
    "Approval Hash": "rich_text",
    "Operation ID": "rich_text",
  };
  const rs = Object.fromEntries(
    Object.entries(types).map(([key, type], i) => [key, { id: "r" + i, type }]),
  );
  const rich = (value: string) => ({
    rich_text: value ? [{ type: "text", text: { content: value } }] : [],
  });
  const p: Record<string, any> = Object.fromEntries(
    Object.entries(rs).map(([key, value]) => [
      key,
      {
        ...value,
        ...(value.type === "title"
          ? {
              title: [
                {
                  type: "text",
                  text: { content: "Synthetic proposed duplicate" },
                },
              ],
            }
          : value.type === "select"
            ? { select: null }
            : value.type === "relation"
              ? { relation: [] }
              : value.type === "number"
                ? { number: null }
                : value.type === "date"
                  ? { date: null }
                  : rich("")),
      },
    ]),
  );
  const key = await pairKey(idea.id, matchingId);
  p["Candidate Idea"].relation = [{ id: idea.id }];
  p["Potential Matching Idea"].relation = [{ id: matchingId }];
  p.Status.select = { name: "Pending" };
  p["Review Type"].select = { name: "potential duplicate" };
  p["AI Recommendation"].select = { name: "Duplicate" };
  p["Similarity Score"].number = 0.84;
  Object.assign(
    p.Reasoning,
    rich("Synthetic AI suggestion: similar sensor words."),
  );
  Object.assign(
    p["Candidate Revision"],
    rich(options.legacy ? "" : idea.revision),
  );
  Object.assign(p["Match Revision"], rich(options.legacy ? "" : idea.revision));
  Object.assign(p["Pair Key"], rich(key));
  Object.assign(
    p["Proposal Payload"],
    rich(
      JSON.stringify({
        original: "synthetic-proposal",
        notes: "preserve original evidence",
      }),
    ),
  );
  Object.assign(p["Operation ID"], rich("original-proposal-operation"));
  Object.assign(p["Embedding Version"], rich("synthetic-embedding-v1"));
  Object.assign(p["Classification Version"], rich("synthetic-classifier-v1"));
  let candidate = page(),
    matching = page({
      id: matchingId,
      properties: {
        ...props(),
        Title: {
          ...props().Title,
          title: [{ plain_text: "Synthetic sensor conference demo" }],
        },
      },
    }),
    original = page({
      id: originalId,
      url: "https://app.notion.com/p/" + originalId,
      parent: { type: "data_source_id", data_source_id: ids.reviews },
      properties: p,
    }),
    saved: any = null;
  const originalSnapshot = structuredClone(original),
    calls: { path: string; method: string; body: any }[] = [];
  const request = vi.fn(async (url: any, options: any) => {
    const target = String(url).replace("https://api.notion.com/v1/", ""),
      body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ path: target, method: options.method, body });
    if (target === "data_sources/" + ids.ideas) return Response.json(schema());
    if (target === "data_sources/" + ids.reviews)
      return Response.json({ properties: rs });
    if (target === "data_sources/" + ids.sources + "/query")
      return Response.json({ results: [], has_more: false });
    if (target === "data_sources/" + ids.reviews + "/query") {
      const rows = [original, ...(saved ? [saved] : [])].filter((r) =>
        body.filter.property === "Operation ID"
          ? r.properties["Operation ID"].rich_text.some(
              (t: any) => t.text.content === body.filter.rich_text.equals,
            )
          : r.properties["Pair Key"].rich_text.some(
              (t: any) => t.text.content === body.filter.rich_text.equals,
            ),
      );
      return Response.json({ results: rows, has_more: false });
    }
    if (target === "pages/" + idea.id) return Response.json(candidate);
    if (target === "pages/" + matchingId) return Response.json(matching);
    if (target === "pages/" + originalId && options.method === "GET")
      return Response.json(original);
    if (target === "pages/" + decisionId && options.method === "GET")
      return Response.json(saved);
    if (target === "pages" && body.parent.data_source_id === ids.reviews) {
      const properties = Object.fromEntries(
        Object.entries(rs).map(([name, r]) => [
          name,
          { ...r, ...body.properties[r.id] },
        ]),
      );
      saved = page({
        id: decisionId,
        url: "https://app.notion.com/p/" + decisionId,
        parent: { type: "data_source_id", data_source_id: ids.reviews },
        properties,
      });
      return Response.json(saved);
    }
    if (target === "pages/" + originalId && options.method === "PATCH") {
      if (optionsReject())
        return Response.json({ error: "denied" }, { status: 403 });
      for (const [propertyId, value] of Object.entries(body.properties)) {
        const name = Object.keys(rs).find((n) => rs[n].id === propertyId)!;
        original.properties[name] = {
          ...original.properties[name],
          ...(value as object),
        };
      }
      original = { ...original, last_edited_time: "2026-10-31T01:00:00.000Z" };
      return optionsLost()
        ? Response.json({ error: "lost response" }, { status: 503 })
        : Response.json(original);
    }
    throw new Error("Unexpected mock provider request " + target);
  });
  const optionsReject = () => !!options.rejectClose,
    optionsLost = () => !!options.lostCloseResponse;
  return {
    request,
    calls,
    rs,
    key,
    originalSnapshot,
    get original() {
      return original;
    },
    get saved() {
      return saved;
    },
    get candidate() {
      return candidate;
    },
    set candidate(value) {
      candidate = value;
    },
  };
}
describe("canonical review persistence against a mocked Notion provider", () => {
  it("preserves original proposal fields and idea history while appending a manual decision", async () => {
    const p = await provider(),
      m = memoryDB(),
      ops = new Operations(m.db),
      repo = new ReviewRepository(config, p.request),
      service = new ReviewService(repo, ops);
    const context = await repo.contextForReview(originalId),
      command = decisionCommandSchema.parse({
        candidateId: idea.id,
        matchingId: matchingId,
        candidateRevision: context.candidate.revision,
        matchingRevision: context.matching.revision,
        reviewId: originalId,
        reviewRevision: context.review!.revision,
        decision: "Distinct",
        reason: "Different audiences and outcomes.",
      });
    const approval = await service.prepare(command, "owner");
    expect(
      p.calls.filter((c) => c.path === "pages" || c.method === "PATCH"),
    ).toHaveLength(0);
    const saved = await service.execute(
      command,
      approval.approvalToken,
      "owner",
    );
    expect(saved.decisionId).toBe(decisionId);
    const writes = p.calls.filter(
      (c) => c.path === "pages" || c.method === "PATCH",
    );
    expect(writes).toHaveLength(2);
    expect(writes[0].body.properties[p.rs["AI Recommendation"].id]).toEqual({
      select: null,
    });
    expect(writes[0].body.properties[p.rs["Similarity Score"].id]).toEqual({
      number: null,
    });
    expect(p.original.properties.Status.select.name).toBe("Rejected");
    for (const name of [
      "Reasoning",
      "AI Recommendation",
      "Candidate Revision",
      "Match Revision",
      "Pair Key",
      "Proposal Payload",
      "Embedding Version",
      "Classification Version",
      "Operation ID",
    ])
      expect(p.original.properties[name]).toEqual(
        p.originalSnapshot.properties[name],
      );
    const patch = Object.keys(writes[1].body.properties);
    expect(patch.sort()).toEqual(
      [
        "Status",
        "Reviewer Decision",
        "Reviewed Date",
        "Reviewer",
        "Approval Hash",
      ]
        .map((n) => p.rs[n].id)
        .sort(),
    );
    expect(
      writes.some(
        (w) =>
          w.path === "pages/" + idea.id || w.path === "pages/" + matchingId,
      ),
    ).toBe(false);
    const snapshot = p.saved.properties["Proposal Payload"].rich_text
      .map((t: any) => t.text.content)
      .join("");
    expect(JSON.parse(snapshot)).toMatchObject({
      decision: "Distinct",
      origin: "manual",
      scope: "classification-only",
      originalReviewId: originalId,
    });
    expect(
      (await service.execute(command, approval.approvalToken, "owner"))
        .replayed,
    ).toBe(true);
    expect(
      p.calls.filter((c) => c.path === "pages" || c.method === "PATCH"),
    ).toHaveLength(2);
    const scoreOnly = structuredClone(p.candidate);
    scoreOnly.properties.Status.select = { name: "Active" };
    scoreOnly.properties["Priority Score"].number = 90;
    scoreOnly.last_edited_time = "2026-10-31T02:00:00.000Z";
    p.candidate = scoreOnly;
    expect((await repo.context(idea.id, matchingId)).priorDecision?.id).toBe(
      decisionId,
    );
    const material = structuredClone(p.candidate);
    material.properties["Problem Statement"].rich_text = [
      { plain_text: "A newly specified problem and different audience." },
    ];
    material.last_edited_time = "2026-10-31T03:00:00.000Z";
    p.candidate = material;
    const changed = await repo.context(idea.id, matchingId);
    expect(changed.priorDecision).toBeNull();
    expect(changed.reopened).toBe(true);
    m.close();
  });
  it("rejects an obsolete legacy suggestion without suppressing current content", async () => {
    const p = await provider({ legacy: true }),
      m = memoryDB(),
      ops = new Operations(m.db),
      repo = new ReviewRepository(config, p.request),
      service = new ReviewService(repo, ops);
    const context = await repo.contextForReview(originalId);
    expect(context.staleProposal).toBe(true);
    const command = decisionCommandSchema.parse({
      candidateId: idea.id,
      matchingId: matchingId,
      candidateRevision: context.candidate.revision,
      matchingRevision: context.matching.revision,
      reviewId: originalId,
      reviewRevision: context.review!.revision,
      decision: "Reject",
      reason:
        "Input versions were not recorded; compare the current ideas separately.",
    });
    const approval = await service.prepare(command, "owner");
    await service.execute(command, approval.approvalToken, "owner");
    const result = await repo.context(idea.id, matchingId);
    expect(result.priorDecision).toBeNull();
    expect(p.original.properties["Candidate Revision"].rich_text).toEqual([]);
    expect(
      (
        await repo.findDecision(
          (await ops.read(approval.approvalToken, "owner")).id,
        )
      )?.snapshot?.candidateHash,
    ).toBeNull();
    m.close();
  });
  it("reconciles a lost queue-update response without replaying any mutation", async () => {
    const p = await provider({ lostCloseResponse: true }),
      m = memoryDB(),
      ops = new Operations(m.db),
      repo = new ReviewRepository(config, p.request),
      service = new ReviewService(repo, ops),
      context = await repo.contextForReview(originalId);
    const command = decisionCommandSchema.parse({
        candidateId: idea.id,
        matchingId: matchingId,
        candidateRevision: context.candidate.revision,
        matchingRevision: context.matching.revision,
        reviewId: originalId,
        reviewRevision: context.review!.revision,
        decision: "Related",
        reason: "Shared components; independent deliverables.",
      }),
      approval = await service.prepare(command, "owner");
    await expect(
      service.execute(command, approval.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    const op = await ops.read(approval.approvalToken, "owner");
    expect((await service.reconcile(op.id, "owner")).status).toBe("done");
    expect(
      p.calls.filter((c) => c.path === "pages" || c.method === "PATCH"),
    ).toHaveLength(2);
    m.close();
  });
  it("keeps a failed pending-review update unresolved and preserves its original proposal", async () => {
    const p = await provider({ rejectClose: true }),
      m = memoryDB(),
      ops = new Operations(m.db),
      repo = new ReviewRepository(config, p.request),
      service = new ReviewService(repo, ops),
      context = await repo.contextForReview(originalId);
    const command = decisionCommandSchema.parse({
        candidateId: idea.id,
        matchingId: matchingId,
        candidateRevision: context.candidate.revision,
        matchingRevision: context.matching.revision,
        reviewId: originalId,
        reviewRevision: context.review!.revision,
        decision: "Related",
        reason: "Independent outcomes.",
      }),
      approval = await service.prepare(command, "owner");
    await expect(
      service.execute(command, approval.approvalToken, "owner"),
    ).rejects.toMatchObject({ code: "WRITE_UNCERTAIN" });
    expect(
      (
        await service.reconcile(
          (await ops.read(approval.approvalToken, "owner")).id,
          "owner",
        )
      ).status,
    ).toBe("uncertain");
    expect(p.original).toEqual(p.originalSnapshot);
    m.close();
  });
});
