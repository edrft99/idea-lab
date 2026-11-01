import { describe, it, expect, vi } from "vitest";
import { EvaluationRepository } from "../lib/evaluations/repository";
import { EvaluationService } from "../lib/evaluations/service";
import { Operations } from "../lib/ideas/operations";
import {
  evaluationDraftSchema,
  evaluationCommandSchema,
  potential,
  defaultWeights,
} from "../lib/evaluations/model";
import { memoryDB, config, ids, idea, props, page, schema } from "./fixtures";
const evalId = "70000000-0000-4000-8000-000000000007";
const draft = evaluationDraftSchema.parse({
  rubricVersion: "potential-v1",
  weights: defaultWeights,
  ratings: {
    impact: 4,
    alignment: 3,
    feasibility: 4,
    reusability: 5,
    timing: 2,
  },
  evidence: {
    impact: "Demonstration evidence.",
    alignment: "Aligned with goals.",
    feasibility: "Prototype works.",
    reusability: "Reusable parts.",
    timing: "No deadline known.",
  },
  rationale: "A useful prototype.",
  benefits: "Reuse.",
  risks: "Integration.",
  assumptions: "Parts available.",
  effort: "Weekend",
  readiness: "Ready to explore",
  confidence: 0.7,
  nextAction: "Validate the prototype.",
});
function provider() {
  const fields: Record<string, string> = {
    Name: "title",
    "Related Idea": "relation",
    "Evaluation Date": "date",
    "Overall Score": "number",
    "Impact Score": "number",
    "Alignment Score": "number",
    "Feasibility Score": "number",
    "Reusability Score": "number",
    "Timing Score": "number",
    Rationale: "rich_text",
    Risks: "rich_text",
    Assumptions: "rich_text",
    "Recommended Next Action": "rich_text",
    "Model Identifier": "rich_text",
    "Rubric Version": "rich_text",
    "Potential Benefits": "rich_text",
    "Estimated Effort": "select",
    Readiness: "select",
    Confidence: "number",
    Authority: "select",
    "Approved By": "rich_text",
    "Approved At": "date",
    "Input Revision": "rich_text",
    "Weight Snapshot": "rich_text",
  };
  const evalSchema = Object.fromEntries(
    Object.entries(fields).map(([key, type], i) => [
      key,
      { id: "e" + i, type },
    ]),
  );
  const initial = props();
  initial["Score Authority"].select = { name: "manual-approved" };
  initial["Priority Score"].number = 50;
  for (const k of [
    "Impact",
    "Strategic Alignment",
    "Feasibility",
    "Reusability",
    "Timing",
  ])
    initial[k].number = 3;
  let current = page({ properties: initial }),
    evaluation: any = null;
  const calls: { path: string; method: string; body: any }[] = [];
  const request = vi.fn(async (url: any, options: any) => {
    const target = String(url).replace("https://api.notion.com/v1/", ""),
      body = options?.body ? JSON.parse(options.body) : null;
    calls.push({ path: target, method: options?.method ?? "GET", body });
    if (target === "data_sources/" + ids.ideas) return Response.json(schema());
    if (target === "data_sources/" + ids.evaluations)
      return Response.json({ properties: evalSchema });
    if (target === "data_sources/" + ids.reviews + "/query")
      return Response.json({ results: [], has_more: false });
    if (target === "data_sources/" + ids.sources + "/query")
      return Response.json({ results: [], has_more: false });
    if (target === "data_sources/" + ids.evaluations + "/query")
      return Response.json({
        results: evaluation ? [evaluation] : [],
        has_more: false,
      });
    if (target === "pages/" + ids.idea && options.method === "GET")
      return Response.json(current);
    if (target === "pages" && body.parent.data_source_id === ids.evaluations) {
      const properties = Object.fromEntries(
        Object.entries(evalSchema).map(([name, p]) => [
          name,
          { ...p, ...body.properties[p.id] },
        ]),
      );
      evaluation = page({
        id: evalId,
        parent: { type: "data_source_id", data_source_id: ids.evaluations },
        properties,
      });
      return Response.json(evaluation);
    }
    if (target === "pages/" + ids.idea && options.method === "PATCH") {
      const p = current.properties;
      for (const [propertyId, value] of Object.entries(body.properties)) {
        const key = Object.keys(p).find((k) => p[k].id === propertyId)!;
        p[key] = { ...p[key], ...(value as object) };
      }
      current = { ...current, last_edited_time: "2026-10-31T01:00:00.000Z" };
      return Response.json(current);
    }
    throw new Error("Unexpected mocked provider request " + target);
  });
  return {
    request,
    calls,
    evalSchema,
    get current() {
      return current;
    },
  };
}
describe("evaluation persistence against mocked Notion", () => {
  it.each([false, true])(
    "appends immutable history; applyToIdea=%s",
    async (apply) => {
      const p = provider(),
        m = memoryDB(),
        ops = new Operations(m.db),
        repo = new EvaluationRepository(config, p.request),
        service = new EvaluationService(repo, ops);
      const command = evaluationCommandSchema.parse({
        ideaId: idea.id,
        expectedRevision: idea.revision,
        draft,
        applyToIdea: apply,
        replaceManualScore: apply,
        overrideReason: apply
          ? "A validated prototype improves feasibility."
          : "",
      });
      const approval = await service.prepare(command, "owner");
      expect(
        p.calls.filter(
          (c) => ["PATCH"].includes(c.method) || c.path === "pages",
        ),
      ).toHaveLength(0);
      const saved = await service.execute(
        command,
        approval.approvalToken,
        "owner",
      );
      expect(saved.evaluationId).toBe(evalId);
      const creates = p.calls.filter((c) => c.path === "pages");
      expect(creates).toHaveLength(1);
      const fields = creates[0].body.properties,
        es = p.evalSchema;
      expect(fields[es["Overall Score"].id]).toEqual({
        number: potential(draft.ratings),
      });
      expect(fields[es["Input Revision"].id].rich_text[0].text.content).toBe(
        idea.revision,
      );
      expect(
        JSON.parse(fields[es["Weight Snapshot"].id].rich_text[0].text.content),
      ).toEqual(defaultWeights);
      expect(fields[es["Model Identifier"].id].rich_text[0].text.content).toBe(
        "manual",
      );
      expect(fields[es.Authority.id].select.name).toBe("manual-approved");
      const snapshot = JSON.parse(
        creates[0].body.children[1].code.rich_text
          .map((t: any) => t.text.content)
          .join(""),
      );
      expect(snapshot.draft.evidence).toEqual(draft.evidence);
      expect(snapshot.inputRevision).toBe(idea.revision);
      expect(snapshot.overrideReason).toBe(command.overrideReason);
      const updates = p.calls.filter((c) => c.method === "PATCH");
      expect(updates).toHaveLength(apply ? 1 : 0);
      if (apply) {
        const named = props(),
          forbidden = [
            "Title",
            "Summary",
            "Sources",
            "Related Ideas",
            "Estimated Effort",
            "Readiness",
            "Next Action",
            "Status",
          ];
        for (const name of forbidden)
          expect(updates[0].body.properties).not.toHaveProperty(named[name].id);
        expect(p.current.properties["Priority Score"].number).toBe(68);
        expect(p.current.properties["Latest Evaluation"].relation).toEqual([
          { id: evalId },
        ]);
      } else expect(p.current.properties["Priority Score"].number).toBe(50);
      expect(
        (await service.execute(command, approval.approvalToken, "owner"))
          .replayed,
      ).toBe(true);
      expect(p.calls.filter((c) => c.path === "pages")).toHaveLength(1);
      expect((await ops.read(approval.approvalToken, "owner")).result_id).toBe(
        evalId,
      );
      m.close();
    },
  );
});
