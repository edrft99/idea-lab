import { verifyAIResult } from "../intelligence/service";
import { AppError } from "../ideas/errors";
import { editable } from "../ideas/domain";
import { Operations, digest, type Operation } from "../ideas/operations";
import {
  validateProjection,
  potential,
  dimensions,
  dimensionLabels,
  type EvaluationCommand,
} from "./model";
import {
  assessmentStoreSchema,
  assessmentDecisionSchema,
  assessmentKey,
  type AssessmentStore,
  type AssessmentSnapshot,
  type AssessmentDecision,
  type AssessmentIntent,
} from "./proposal-model";
import { AssessmentRepository } from "./proposal-repository";
export class AssessmentService {
  constructor(
    private repository: AssessmentRepository,
    private operations: Operations,
  ) {}
  private async available(c: AssessmentStore, actor: string) {
    if (c.ai) {
      await verifyAIResult(c.ai, this.operations, actor);
      if (
        c.ai.ideaId !== c.ideaId ||
        c.ai.inputRevision !== c.inputRevision ||
        JSON.stringify(c.ai.draft) !== JSON.stringify(c.draft)
      )
        throw new AppError(
          "AI_PROVENANCE_INVALID",
          "The proposed draft differs from its confirmed AI result. Save edited content as a manual assessment.",
          409,
        );
    }
    const idea = await this.repository.get(c.ideaId);
    if (idea.canonicalIdeaId)
      throw new AppError(
        "SUPERSEDED_IDEA",
        "Assess the surviving idea.",
        409,
        undefined,
        false,
        [idea.canonicalIdeaId],
      );
    if (idea.revision !== c.inputRevision)
      throw new AppError(
        "STALE_IDEA",
        "This assessment refers to an older idea revision. Reload and review the evidence.",
        409,
      );
    const key = await assessmentKey(c.ideaId, c.inputRevision, c.draft),
      hint = await this.operations.latestResult(actor, "assessment-store", key),
      history = await this.repository.history(key, hint);
    const unresolved = history.find((r) => r.status !== "Rejected");
    if (unresolved)
      throw new AppError(
        "ASSESSMENT_ALREADY_QUEUED",
        "This assessment already has saved review history. Open it before another save.",
        409,
        undefined,
        false,
        [],
        [unresolved.id],
      );
    const rejected = history.find((r) => r.status === "Rejected");
    if (rejected && !c.reconsider)
      throw new AppError(
        "ASSESSMENT_REJECTED",
        "This exact assessment was rejected. Explicitly reconsider it with a reason.",
        409,
        undefined,
        false,
        [],
        [rejected.id],
      );
    return { idea, key, rejected };
  }
  private snapshot(
    c: AssessmentStore,
    actor: string,
    op: string,
    hash: string,
    input: ReturnType<typeof editable>,
    key: string,
  ): AssessmentSnapshot {
    return {
      format: "idea-lab-assessment-proposal",
      version: 1,
      operation: op,
      actor,
      command: c,
      commandHash: hash,
      key,
      input,
      createdAt: new Date().toISOString(),
    };
  }
  async prepareStore(input: AssessmentStore, actor: string) {
    const c = assessmentStoreSchema.parse(input),
      context = await this.available(c, actor),
      hash = await digest(JSON.stringify(c));
    this.repository.body(
      this.snapshot(
        c,
        actor,
        "0".repeat(64),
        hash,
        editable(context.idea),
        context.key,
      ),
    );
    const receipt = await this.operations.issue(
      actor,
      hash,
      "assessment-store",
      context.key,
      c.inputRevision,
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: [
        {
          field: "Scope",
          before: "Local assessment",
          after:
            "Save one Pending assessment in Notion Review Queue. No evaluation history or active score is written.",
        },
        {
          field: "Input idea and revision",
          before: "",
          after: context.idea.title + "\n" + c.inputRevision,
        },
        ...this.draftChanges(c),
        { field: "Queue note", before: "", after: c.note },
        ...(context.rejected
          ? [
              {
                field: "Reconsideration",
                before: context.rejected.id,
                after: c.reconsiderReason,
              },
            ]
          : []),
      ],
    };
  }
  private draftChanges(c: AssessmentStore) {
    const d = c.draft;
    return [
      ...(c.ai
        ? [
            {
              field: "AI origin and selected input",
              before: "",
              after:
                c.ai.resolvedModel +
                " · deployment " +
                c.ai.deployment +
                " · prompt " +
                c.ai.promptVersion +
                "\n" +
                c.ai.endpoint +
                "\n" +
                c.ai.retentionNotice +
                "\n" +
                JSON.stringify(c.ai.input.selection, null, 2),
            },
          ]
        : []),
      ...dimensions.map((k) => ({
        field: dimensionLabels[k],
        before: "",
        after: d.ratings[k] + "/5 · " + d.weights[k] + "%\n" + d.evidence[k],
      })),
      {
        field: "Potential",
        before: "",
        after: potential(d.ratings, d.weights) + "/100",
      },
      {
        field: "Rubric",
        before: "",
        after: d.rubricVersion + "\n" + JSON.stringify(d.weights),
      },
      {
        field: "Rationale / benefits / risks / assumptions",
        before: "",
        after: [d.rationale, d.benefits, d.risks, d.assumptions].join("\n\n"),
      },
      {
        field: "Effort / readiness / confidence",
        before: "",
        after:
          d.effort +
          " · " +
          d.readiness +
          " · " +
          Math.round(d.confidence * 100) +
          "%",
      },
      { field: "Recommended next action", before: "", after: d.nextAction },
    ];
  }
  async store(input: AssessmentStore, token: string, actor: string) {
    const c = assessmentStoreSchema.parse(input),
      hash = await digest(JSON.stringify(c)),
      op = await this.operations.read(token, actor);
    if (op.action !== "assessment-store" || op.payload_hash !== hash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The assessment changed. Review storage again.",
        409,
      );
    if (op.status === "done") return { reviewId: op.result_id, replayed: true };
    await this.operations.claim(op, hash, [c.ideaId]);
    let attempted = false;
    try {
      const context = await this.available(c, actor);
      if (context.key !== op.target || c.inputRevision !== op.expected_revision)
        throw new AppError(
          "APPROVAL_CHANGED",
          "The input context changed.",
          409,
        );
      const j = this.snapshot(
        c,
        actor,
        op.id,
        hash,
        editable(context.idea),
        context.key,
      );
      attempted = true;
      const row = await this.repository.appendProposal(j);
      await this.operations.finish(op.id, "done", row.id);
      return { reviewId: row.id, replayed: false };
    } catch (error) {
      try {
        await this.operations.finish(op.id, attempted ? "uncertain" : "failed");
      } catch {}
      if (attempted)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "Assessment storage is unconfirmed. Check Recent Saves before another request.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  private evaluation(
    j: AssessmentSnapshot,
    c: Extract<AssessmentDecision, { decision: "Approve" }>,
  ): EvaluationCommand {
    return {
      ideaId: j.command.ideaId,
      expectedRevision: j.command.inputRevision,
      draft: j.command.draft,
      applyToIdea: c.applyToIdea,
      replaceManualScore: c.replaceManualScore,
      overrideReason: c.overrideReason,
    };
  }
  private async checked(c: AssessmentDecision) {
    const row = await this.repository.proposal(c.proposalId);
    if (row.status !== "Pending" || row.revision !== c.proposalRevision)
      throw new AppError(
        "STALE_PROPOSAL",
        "This assessment changed or was resolved. Reload before reviewing.",
        409,
      );
    if (c.decision === "Approve") {
      const idea = await this.repository.get(row.snapshot.command.ideaId);
      if (idea.canonicalIdeaId)
        throw new AppError(
          "SUPERSEDED_IDEA",
          "Assess the surviving idea.",
          409,
          undefined,
          false,
          [idea.canonicalIdeaId],
        );
      try {
        validateProjection(this.evaluation(row.snapshot, c), idea);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "MANUAL_SCORE_PROTECTED"
        )
          throw new AppError(
            "MANUAL_SCORE_PROTECTED",
            "Replacing a manually approved score needs explicit consent and a reason.",
            409,
          );
        throw new AppError(
          "STALE_IDEA",
          "The idea changed after this assessment was proposed. Reassess it before acceptance.",
          409,
        );
      }
      if (JSON.stringify(editable(idea)) !== JSON.stringify(row.snapshot.input))
        throw new AppError(
          "STALE_IDEA",
          "The saved idea snapshot differs from the current input.",
          409,
        );
    }
    return row;
  }
  private context(revision: string, j: AssessmentSnapshot) {
    return digest(JSON.stringify([revision, j]));
  }
  async prepareDecision(input: AssessmentDecision, actor: string) {
    const c = assessmentDecisionSchema.parse(input),
      row = await this.checked(c),
      hash = await digest(JSON.stringify(c));
    if (c.decision === "Approve") await this.repository.preflight();
    this.repository.body({
      format: "idea-lab-assessment-decision",
      version: 1,
      operation: "0".repeat(64),
      actor,
      command: c,
      payloadHash: hash,
      proposal: row.snapshot,
      createdAt: new Date().toISOString(),
    });
    const receipt = await this.operations.issue(
      actor,
      hash,
      "assessment-" + c.decision.toLowerCase(),
      "review:" + row.id,
      await this.context(row.revision, row.snapshot),
    );
    return {
      approvalToken: receipt.token,
      expiresAt: new Date(receipt.expires).toISOString(),
      changes: [
        {
          field: "Saved assessment",
          before: row.id,
          after:
            row.snapshot.input.title +
            "\nInput revision: " +
            row.snapshot.command.inputRevision,
        },
        ...this.draftChanges(row.snapshot.command),
        { field: "Decision reason", before: "Pending", after: c.reason },
        {
          field: "Scope",
          before: "Pending proposal",
          after:
            c.decision === "Reject"
              ? "Record rejection and preserve the assessment. No evaluation history or idea score is written."
              : c.applyToIdea
                ? "Append one immutable manually approved evaluation and replace the active ratings, confidence and selected evaluation. Preserve idea descriptions, lifecycle, effort, readiness and next action."
                : "Append one immutable manually approved evaluation. Keep the active score and selected evaluation unchanged.",
        },
        ...(c.decision === "Approve" && c.applyToIdea && c.overrideReason
          ? [
              {
                field: "Manual override reason",
                before: "",
                after: c.overrideReason,
              },
            ]
          : []),
      ],
    };
  }
  private async intent(op: Operation, actor: string) {
    const intent = await this.repository.findIntent(op.id);
    if (!intent) return null;
    const j = intent.snapshot;
    if (
      j.actor !== actor ||
      j.payloadHash !== op.payload_hash ||
      (await digest(JSON.stringify(j.command))) !== op.payload_hash ||
      op.target !== "review:" + j.command.proposalId ||
      op.action !== "assessment-" + j.command.decision.toLowerCase() ||
      (await this.context(j.command.proposalRevision, j.proposal)) !==
        op.expected_revision
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "The saved assessment intent differs from its exact approval.",
        409,
      );
    return intent;
  }
  private async progress(j: AssessmentIntent) {
    if (j.command.decision === "Reject")
      return { evaluation: null, projectionReady: true, canProject: false };
    const c = this.evaluation(j.proposal, j.command),
      evaluation = await this.repository.confirmedEvaluation(
        c,
        j.operation,
        j.actor,
        j.proposal.command.ai,
      );
    if (!evaluation)
      return { evaluation: null, projectionReady: false, canProject: false };
    if (!c.applyToIdea)
      return { evaluation, projectionReady: true, canProject: false };
    const idea = await this.repository.get(c.ideaId),
      d = c.draft;
    const projected =
      idea.latestEvaluationId === evaluation.id &&
      idea.revision.split("@")[0].endsWith(";revision:" + j.operation) &&
      idea.priorityScore === potential(d.ratings, d.weights) &&
      dimensions.every((k) => idea.scores[k] === d.ratings[k]) &&
      idea.confidence === d.confidence &&
      idea.scoreAuthority === "manual-approved" &&
      !idea.canonicalIdeaId &&
      JSON.stringify(editable(idea)) === JSON.stringify(j.proposal.input);
    return {
      evaluation,
      projectionReady: projected,
      canProject:
        !idea.canonicalIdeaId &&
        idea.revision === c.expectedRevision &&
        JSON.stringify(editable(idea)) === JSON.stringify(j.proposal.input),
    };
  }
  async decide(input: AssessmentDecision, token: string, actor: string) {
    const c = assessmentDecisionSchema.parse(input),
      hash = await digest(JSON.stringify(c)),
      op = await this.operations.read(token, actor);
    if (
      op.action !== "assessment-" + c.decision.toLowerCase() ||
      op.payload_hash !== hash
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The assessment decision changed. Review it again.",
        409,
      );
    if (op.status === "done")
      return {
        reviewId: c.proposalId,
        ideaId: c.decision === "Approve" ? op.result_id : null,
        replayed: true,
      };
    const before = await this.checked(c);
    if (
      (await this.context(before.revision, before.snapshot)) !==
      op.expected_revision
    )
      throw new AppError(
        "APPROVAL_CHANGED",
        "The saved assessment inputs changed.",
        409,
      );
    await this.operations.claim(op, hash, [before.snapshot.command.ideaId]);
    let attempted = false;
    try {
      const row = await this.checked(c),
        j: AssessmentIntent = {
          format: "idea-lab-assessment-decision",
          version: 1,
          operation: op.id,
          actor,
          command: c,
          payloadHash: hash,
          proposal: row.snapshot,
          createdAt: new Date().toISOString(),
        };
      attempted = true;
      const intent = await this.repository.appendIntent(j);
      let evaluationId: string | null = null;
      if (c.decision === "Approve") {
        await this.checked(c);
        await this.repository.preflight();
        const command = this.evaluation(j.proposal, c);
        const evaluation = await this.repository.appendEvaluation(
          command,
          op.id,
          actor,
          j.proposal.command.ai,
        );
        evaluationId = evaluation.id;
        const saved = await this.repository.confirmedEvaluation(
          command,
          op.id,
          actor,
          j.proposal.command.ai,
        );
        if (!saved || saved.id !== evaluationId)
          throw new Error("History unconfirmed");
        if (c.applyToIdea)
          await this.repository.projectEvaluation(
            command,
            evaluationId,
            op.id,
            actor,
          );
        if (!(await this.progress(j)).projectionReady)
          throw new Error("Score unconfirmed");
      }
      await this.repository.close(intent, evaluationId);
      await this.operations.finish(
        op.id,
        "done",
        c.decision === "Approve" ? row.snapshot.command.ideaId : row.id,
      );
      return {
        reviewId: row.id,
        ideaId: c.decision === "Approve" ? row.snapshot.command.ideaId : null,
        evaluationId,
        replayed: false,
      };
    } catch (error) {
      try {
        await this.operations.finish(op.id, attempted ? "uncertain" : "failed");
      } catch {}
      if (attempted)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "The assessment decision is not fully confirmed. Check Recent Saves before another save.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  async reconcileToken(token: string, actor: string) {
    return this.reconcile((await this.operations.read(token, actor)).id, actor);
  }
  async reconcile(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (
      !["assessment-store", "assessment-approve", "assessment-reject"].includes(
        op.action,
      )
    )
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an assessment proposal operation.",
        400,
      );
    if (op.status === "done")
      return {
        status: "done",
        reviewId:
          op.action === "assessment-approve"
            ? op.target!.slice(7)
            : op.result_id,
        ideaId: op.action === "assessment-approve" ? op.result_id : null,
        canResume: false,
      };
    if (!["running", "uncertain"].includes(op.status))
      return { status: op.status, canResume: false };
    if (op.action === "assessment-store") {
      const row = await this.repository.findStored(op.id);
      if (!row) return { status: op.status, canResume: false };
      if (
        row.snapshot.actor !== actor ||
        row.snapshot.commandHash !== op.payload_hash ||
        row.snapshot.key !== op.target ||
        row.snapshot.command.inputRevision !== op.expected_revision
      )
        throw new AppError(
          "RECONCILIATION_REQUIRED",
          "The saved assessment differs from storage approval.",
          409,
        );
      await this.operations.finish(op.id, "done", row.id);
      return { status: "done", reviewId: row.id, canResume: false };
    }
    const intent = await this.intent(op, actor);
    if (!intent) return { status: op.status, canResume: false };
    const p = await this.progress(intent.snapshot),
      row = await this.repository.proposal(intent.snapshot.command.proposalId),
      approved = intent.snapshot.command.decision === "Approve";
    if (
      row.decision?.decision === intent.snapshot.command.decision &&
      row.decision?.reason === intent.snapshot.command.reason &&
      row.decision?.operation === op.id &&
      row.decision.intentId === intent.id &&
      (!approved ||
        (p.evaluation &&
          p.projectionReady &&
          row.decision.evaluationId === p.evaluation.id))
    ) {
      await this.operations.finish(
        op.id,
        "done",
        approved ? row.snapshot.command.ideaId : row.id,
      );
      return {
        status: "done",
        reviewId: row.id,
        ideaId: approved ? row.snapshot.command.ideaId : null,
        canResume: false,
      };
    }
    return {
      status: op.status,
      reviewId: row.id,
      canResume:
        op.status === "uncertain" &&
        row.status === "Pending" &&
        row.revision === intent.snapshot.command.proposalRevision &&
        (!approved || (!!p.evaluation && (p.projectionReady || p.canProject))),
    };
  }
  async resume(id: string, actor: string) {
    const op = await this.operations.readById(id, actor);
    if (!["assessment-approve", "assessment-reject"].includes(op.action))
      throw new AppError(
        "INVALID_OPERATION",
        "This assessment operation cannot be resumed.",
        400,
      );
    if (op.status === "done") return this.reconcile(id, actor);
    const intent = await this.intent(op, actor);
    if (!intent)
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "No verified assessment decision intent was found.",
        409,
      );
    const j = intent.snapshot,
      p = await this.progress(j),
      row = await this.repository.proposal(j.command.proposalId);
    if (row.status !== "Pending" || row.revision !== j.command.proposalRevision)
      throw new AppError(
        "STALE_PROPOSAL",
        "The original assessment changed. Check the operation.",
        409,
      );
    if (
      j.command.decision === "Approve" &&
      (!p.evaluation || (!p.projectionReady && !p.canProject))
    )
      throw new AppError(
        "RECONCILIATION_REQUIRED",
        "History or score context is unverified. No evaluation will be recreated.",
        409,
      );
    await this.operations.resume(op, [j.proposal.command.ideaId]);
    try {
      if (
        j.command.decision === "Approve" &&
        j.command.applyToIdea &&
        !p.projectionReady
      ) {
        await this.checked(j.command);
        await this.repository.projectEvaluation(
          this.evaluation(j.proposal, j.command),
          p.evaluation!.id,
          j.operation,
          actor,
        );
        if (!(await this.progress(j)).projectionReady)
          throw new Error("Score unconfirmed");
      }
      await this.repository.close(intent, p.evaluation?.id ?? null);
      await this.operations.finish(
        op.id,
        "done",
        j.command.decision === "Approve" ? row.snapshot.command.ideaId : row.id,
      );
      return {
        status: "done",
        reviewId: row.id,
        ideaId:
          j.command.decision === "Approve" ? row.snapshot.command.ideaId : null,
      };
    } catch (error) {
      try {
        await this.operations.finish(op.id, "uncertain");
      } catch {}
      throw error;
    }
  }
}
