import { AppError } from "../ideas/errors";
import { Operations, digest } from "../ideas/operations";
import {
  decisionCommandSchema,
  type DecisionCommand,
  type PairContext,
} from "./model";
import { ReviewRepository } from "./repository";
export class ReviewService {
  constructor(
    private repository: ReviewRepository,
    private operations: Operations,
  ) {}
  private async checked(command: DecisionCommand): Promise<PairContext> {
    const context = await this.repository.context(
      command.candidateId,
      command.matchingId,
      command.reviewId,
    );
    if (
      context.candidate.id !== command.candidateId ||
      context.matching.id !== command.matchingId
    )
      throw new AppError(
        "INVALID_PAIR",
        "The retrieved records differ from the reviewed pair.",
        409,
      );
    if (
      command.decision !== "Reject" &&
      (context.candidate.canonicalIdeaId || context.matching.canonicalIdeaId)
    )
      throw new AppError(
        "SUPERSEDED_IDEA",
        "Choose the current surviving idea before classifying this pair.",
        409,
        undefined,
        false,
        [
          context.candidate.canonicalIdeaId,
          context.matching.canonicalIdeaId,
        ].filter((id): id is string => !!id),
      );
    if (
      context.candidate.revision !== command.candidateRevision ||
      context.matching.revision !== command.matchingRevision
    )
      throw new AppError(
        "STALE_IDEA",
        "One of the ideas changed. Reload the comparison before reviewing.",
        409,
      );
    if (context.review) {
      if (
        context.review.status !== "Pending" ||
        context.review.revision !== command.reviewRevision
      )
        throw new AppError(
          "STALE_REVIEW",
          "This review changed or was already resolved. Reload it.",
          409,
        );
      if (context.staleProposal && command.decision !== "Reject")
        throw new AppError(
          "STALE_PROPOSAL",
          "The suggested pair was based on older input. Reject the outdated suggestion or start a new comparison of the current ideas.",
          409,
        );
    }
    if (
      context.priorDecision &&
      !command.reconsider &&
      !(context.review && command.decision === "Reject")
    )
      throw new AppError(
        "PAIR_ALREADY_REVIEWED",
        "This content pair already has a decision. Explicitly choose to reconsider it before another classification.",
        409,
      );
    return context;
  }
  async prepare(input: DecisionCommand, actor: string) {
    const command = decisionCommandSchema.parse(input),
      context = await this.checked(command);
    const receipt = await this.operations.issue(
      actor,
      await digest(JSON.stringify(command)),
      "review-decision",
      context.key,
      command.reviewRevision,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: [
        {
          field: "Candidate",
          before: "",
          after:
            context.candidate.title +
            " · " +
            context.candidate.id +
            "\n" +
            command.candidateRevision,
        },
        {
          field: "Possible match",
          before: "",
          after:
            context.matching.title +
            " · " +
            context.matching.id +
            "\n" +
            command.matchingRevision,
        },
        {
          field: "Decision",
          before:
            context.review?.recommendation ??
            context.priorDecision?.decision ??
            "",
          after: command.decision,
        },
        { field: "Reason", before: "", after: command.reason },
        {
          field: "Scope",
          before: "",
          after:
            "Append an immutable manual relationship decision. No idea is merged, linked, edited or deleted.",
        },
        ...(context.review
          ? [
              {
                field: "Pending review",
                before: "Pending",
                after:
                  "Resolve the selected review after the new decision is confirmed. Original reasoning and proposal metadata are preserved.",
              },
            ]
          : []),
        ...(context.staleProposal
          ? [
              {
                field: "Outdated suggestion",
                before: "",
                after:
                  "Reject only the older proposal. This rejection will not suppress suggestions for changed content.",
              },
            ]
          : []),
        ...(context.priorDecision
          ? [
              {
                field: "Prior decision",
                before: context.priorDecision.decision,
                after:
                  "Preserve it and append an explicitly reconsidered decision.",
              },
            ]
          : []),
      ],
    };
  }
  async execute(input: DecisionCommand, token: string, actor: string) {
    const command = decisionCommandSchema.parse(input),
      op = await this.operations.read(token, actor),
      hash = await digest(JSON.stringify(command));
    if (op.action !== "review-decision" || op.payload_hash !== hash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The comparison decision changed. Review it again.",
        409,
      );
    if (op.status === "done")
      return { decisionId: op.result_id, replayed: true };
    await this.operations.claim(op, hash, [
      command.candidateId,
      command.matchingId,
      ...(command.reviewId ? ["review:" + command.reviewId] : []),
    ]);
    let attempted = false,
      appended = false;
    try {
      const context = await this.checked(command);
      if (context.key !== op.target)
        throw new AppError(
          "APPROVAL_CHANGED",
          "The reviewed pair changed.",
          409,
        );
      attempted = true;
      const decision = await this.repository.appendDecision(
        command,
        context,
        op.id,
        actor,
      );
      appended = true;
      await this.repository.closeOriginal(command, op.id, decision, actor);
      await this.operations.finish(op.id, "done", decision.id);
      return { decisionId: decision.id, replayed: false };
    } catch (error) {
      const uncertain =
        appended ||
        (attempted && (!(error instanceof AppError) || error.uncertain));
      try {
        await this.operations.finish(op.id, uncertain ? "uncertain" : "failed");
      } catch {}
      if (uncertain)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The decision or pending-review update could not be confirmed. Check this save before submitting another.",
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
    if (op.action !== "review-decision")
      throw new AppError(
        "INVALID_OPERATION",
        "This is not a relationship decision.",
        400,
      );
    if (op.status === "done")
      return { status: "done", decisionId: op.result_id };
    if (!["running", "uncertain"].includes(op.status))
      return { status: op.status, decisionId: null };
    const saved = await this.repository.findDecision(op.id);
    if (saved) {
      if (
        !saved.snapshot ||
        saved.snapshot.operation !== op.id ||
        saved.pairKey !== op.target
      )
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "The saved decision metadata cannot be verified.",
          409,
        );
      const originalId = saved.snapshot?.originalReviewId;
      if (originalId) {
        const original = await this.repository.review(originalId);
        let same = false;
        try {
          same =
            JSON.parse(original.decision).operation === op.id &&
            original.status === saved.status;
        } catch {}
        if (!same) return { status: op.status, decisionId: saved.id };
      }
      await this.operations.finish(op.id, "done", saved.id);
      return { status: "done", decisionId: saved.id };
    }
    return { status: op.status, decisionId: null };
  }
}
