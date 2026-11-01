import {
  evaluationDraftSchema,
  defaultWeights,
} from "../lib/evaluations/model";
export const draft = evaluationDraftSchema.parse({
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
