import { AppError } from "../ideas/errors";
import { Operations, digest } from "../ideas/operations";
import {
  evaluationCommandSchema,
  validateProjection,
  potential,
  type EvaluationCommand,
  dimensions,
  dimensionLabels,
} from "./model";
import { EvaluationRepository } from "./repository";
export class EvaluationService {
  constructor(
    private repository: EvaluationRepository,
    private operations: Operations,
  ) {}
  private async checked(command: EvaluationCommand) {
    const idea = await this.repository.get(command.ideaId);
    if (idea.canonicalIdeaId)
      throw new AppError(
        "SUPERSEDED_IDEA",
        "Evaluate the surviving idea. The original assessment history is preserved.",
        409,
        undefined,
        false,
        [idea.canonicalIdeaId],
      );
    try {
      validateProjection(command, idea);
    } catch (error) {
      if (error instanceof Error && error.message === "MANUAL_SCORE_PROTECTED")
        throw new AppError(
          "MANUAL_SCORE_PROTECTED",
          "Replacing a manually approved score needs an explicit choice and reason.",
          409,
        );
      throw new AppError(
        "STALE_IDEA",
        "This idea changed. Reload it before reviewing an evaluation.",
        409,
      );
    }
    const saved = await this.repository.assessmentReviews?.(command);
    if (saved?.length)
      throw new AppError(
        "ASSESSMENT_ALREADY_QUEUED",
        "This assessment has saved review history. Open it before saving again.",
        409,
        undefined,
        false,
        [],
        saved,
      );
    return idea;
  }
  async prepare(input: EvaluationCommand, actor: string) {
    const command = evaluationCommandSchema.parse(input),
      idea = await this.checked(command);
    await this.repository.preflight();
    const receipt = await this.operations.issue(
      actor,
      await digest(JSON.stringify(command)),
      command.applyToIdea ? "evaluation-apply" : "evaluation-history",
      command.ideaId,
      command.expectedRevision,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: [
        {
          field: "Evaluation history",
          before: "",
          after:
            "Append one immutable, manually approved evaluation. Existing history stays intact.",
        },
        ...dimensions.map((k) => ({
          field: dimensionLabels[k],
          before: String(idea.scores[k] ?? "Unrated"),
          after:
            command.draft.ratings[k] +
            "/5 · " +
            command.draft.weights[k] +
            "%\n" +
            command.draft.evidence[k],
        })),
        {
          field: "Potential score",
          before: String(idea.priorityScore ?? "Unrated"),
          after:
            potential(command.draft.ratings, command.draft.weights) + "/100",
        },
        {
          field: "Active score",
          before: idea.scoreAuthority ?? "Unrated",
          after: command.applyToIdea
            ? "Replace current ratings, confidence and latest evaluation; mark manually approved."
            : "Keep current score and selected evaluation unchanged.",
        },
        { field: "Rationale", before: "", after: command.draft.rationale },
        {
          field: "Benefits / risks / assumptions",
          before: "",
          after: [
            command.draft.benefits,
            command.draft.risks,
            command.draft.assumptions,
          ].join("\n\n"),
        },
        {
          field: "Effort / readiness / confidence",
          before: "",
          after:
            command.draft.effort +
            " · " +
            command.draft.readiness +
            " · " +
            Math.round(command.draft.confidence * 100) +
            "% confidence (stored in history)",
        },
        {
          field: "Recommended next action",
          before: "",
          after:
            command.draft.nextAction +
            " (stored in history; idea action unchanged)",
        },
        {
          field: "Rubric and weights",
          before: "",
          after:
            command.draft.rubricVersion +
            " · " +
            JSON.stringify(command.draft.weights),
        },
        ...(command.overrideReason
          ? [
              {
                field: "Manual override reason",
                before: "",
                after: command.overrideReason,
              },
            ]
          : []),
      ],
    };
  }
  async execute(input: EvaluationCommand, token: string, actor: string) {
    const command = evaluationCommandSchema.parse(input),
      op = await this.operations.read(token, actor),
      hash = await digest(JSON.stringify(command));
    if (
      op.payload_hash !== hash ||
      op.target !== command.ideaId ||
      op.action !==
        (command.applyToIdea ? "evaluation-apply" : "evaluation-history")
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The evaluation changed. Review it again.",
        409,
      );
    if (op.status === "done")
      return {
        ideaId: command.ideaId,
        evaluationId: op.result_id,
        replayed: true,
      };
    await this.operations.claim(op, hash);
    let appended = false,
      attemptedAppend = false;
    try {
      await this.checked(command);
      await this.repository.preflight();
      attemptedAppend = true;
      const evaluation = await this.repository.appendEvaluation(
        command,
        op.id,
        actor,
      );
      appended = true;
      if (command.applyToIdea)
        await this.repository.projectEvaluation(
          command,
          evaluation.id,
          op.id,
          actor,
        );
      await this.operations.finish(op.id, "done", evaluation.id);
      return {
        ideaId: command.ideaId,
        evaluationId: evaluation.id,
        replayed: false,
      };
    } catch (error) {
      const uncertain =
        appended ||
        (attemptedAppend && (!(error instanceof AppError) || error.uncertain));
      try {
        await this.operations.finish(op.id, uncertain ? "uncertain" : "failed");
      } catch {}
      if (uncertain)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "Evaluation history or active score could not be confirmed. Check this save; do not submit another copy.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  async reconcileToken(token: string, actor: string) {
    const op = await this.operations.read(token, actor);
    return this.reconcile(op.id, actor);
  }
  async reconcile(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (
      !["evaluation-apply", "evaluation-history"].includes(op.action) ||
      !op.target
    )
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an evaluation save.",
        400,
      );
    if (op.status === "done")
      return { status: "done", ideaId: op.target, evaluationId: op.result_id };
    if (!["running", "uncertain"].includes(op.status))
      return { status: op.status, ideaId: op.target, evaluationId: null };
    const saved = await this.repository.findEvaluationOperation(
      op.id,
      op.target,
    );
    if (saved) {
      if (op.action === "evaluation-apply") {
        const idea = await this.repository.get(op.target);
        if (
          idea.latestEvaluationId !== saved.id ||
          !idea.revision.includes(";revision:" + op.id + "@")
        )
          return {
            status: op.status,
            ideaId: op.target,
            evaluationId: saved.id,
          };
      }
      await this.operations.finish(op.id, "done", saved.id);
      return { status: "done", ideaId: op.target, evaluationId: saved.id };
    }
    return { status: op.status, ideaId: op.target, evaluationId: null };
  }
}
