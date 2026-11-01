import { AppError } from "../ideas/errors";
import { digest, Operations } from "../ideas/operations";
import { IdeaService, reviewIdeaCommand } from "../ideas/service";
import {
  editableIdeaSchema,
  commandSchema,
  type IdeaCommand,
} from "../ideas/domain";
import { importSourceSchema } from "../imports/provenance";
import { redact } from "../imports/staging";
import { NotionRepository } from "../ideas/notion";
import { AssistantCaptureStore } from "./store";
import {
  proposeCaptureSchema,
  updateCaptureSchema,
  captureRetention,
  type ProposeCapture,
  type UpdateCapture,
  type StoredCapture,
} from "./model";
export class AssistantCaptureService {
  constructor(
    private repository: NotionRepository,
    private operations: Operations,
    private store: AssistantCaptureStore,
    private secrets: string[] = [],
  ) {}
  private data(input: ProposeCapture["data"]) {
    if (input.projectUrl.length > 2000)
      throw new AppError(
        "INVALID_CAPTURE",
        "Use a project URL shorter than 2,000 characters.",
        400,
      );
    const values = Object.fromEntries(
      Object.entries(input).map(([k, v]) => [
        k,
        typeof v === "string" ? redact(v, this.secrets) : v,
      ]),
    );
    if (values.projectUrl && values.projectUrl !== input.projectUrl)
      values.projectUrl = "";
    return editableIdeaSchema.parse(values);
  }
  private writer() {
    return new IdeaService(this.repository, this.operations);
  }
  private reviewPath(id: string) {
    return "/capture/assistant/" + id;
  }
  private async stage(
    command: IdeaCommand,
    client: StoredCapture["client"],
    key: string,
    requestHash: string,
    actor: string,
  ) {
    await this.store.purge(actor);
    const prior = await this.store.byRequest(actor, key);
    if (prior) {
      if (prior.request_hash !== requestHash)
        throw new AppError(
          "CAPTURE_REQUEST_CHANGED",
          "This capture ID was already used for different content. Inspect its original state; use a new ID only for a new reviewed request.",
          409,
        );
      return this.status(prior.id, actor);
    }
    const receipt = await this.writer().prepare(command, actor),
      id = await digest(receipt.approvalToken),
      row = await this.store.insert(
        actor,
        key,
        { client, requestHash, command },
        id,
      );
    if (row.request_hash !== requestHash)
      throw new AppError(
        "CAPTURE_REQUEST_CHANGED",
        "Another request used this capture ID with different content.",
        409,
      );
    return this.status(row.id, actor);
  }
  async propose(input: ProposeCapture, actor: string) {
    const c = proposeCaptureSchema.parse(input),
      data = this.data(c.data),
      evidence = redact(c.evidence, this.secrets),
      origin = c.origin,
      originalUrl =
        origin?.url && redact(origin.url, this.secrets) === origin.url
          ? origin.url
          : null;
    const source = importSourceSchema.parse({
      system: c.client,
      conversationId: origin?.conversationId
        ? redact(origin.conversationId, this.secrets)
        : "assistant-capture:" + c.captureId,
      messageId: origin?.messageId
        ? redact(origin.messageId, this.secrets)
        : "assistant-capture:" + c.captureId,
      locator: origin?.locator
        ? redact(origin.locator, this.secrets)
        : "Selected " +
          c.client +
          " capture " +
          c.captureId +
          "; original conversation/message IDs " +
          (origin?.conversationId && origin?.messageId
            ? "reported by client"
            : "not supplied"),
      originalUrl,
      conversationDate: origin?.conversationDate ?? null,
      adapterVersion: "assistant-capture-v1",
      role: origin?.role ?? "user",
      evidence,
    });
    const command = commandSchema.parse({ action: "create", data, source }),
      requestHash = await digest(JSON.stringify(command));
    return this.stage(
      command,
      c.client,
      await digest(JSON.stringify([c.client, c.captureId])),
      requestHash,
      actor,
    );
  }
  async update(input: UpdateCapture, actor: string) {
    const c = updateCaptureSchema.parse(input),
      command = commandSchema.parse({
        action: "update",
        id: c.id,
        expectedRevision: c.expectedRevision,
        data: this.data(c.data),
      });
    return this.stage(
      command,
      c.client,
      await digest(JSON.stringify([c.client, c.captureId])),
      await digest(JSON.stringify(command)),
      actor,
    );
  }
  async status(id: string, actor: string) {
    await this.store.purge(actor);
    const { row, op } = await this.store.read(actor, id);
    if (op.status === "done" && op.result_id) {
      await this.store.forget(actor, id);
      const idea = await this.repository.get(op.result_id);
      return {
        proposalId: id,
        status: "done",
        ideaId: idea.id,
        canonicalUrl: idea.url,
        reviewPath: this.reviewPath(id),
        message:
          "Canonical save verified. The temporary draft payload was cleared.",
      };
    }
    return {
      proposalId: id,
      status:
        op.status === "pending" && row.expires_at <= Date.now()
          ? "expired"
          : op.status,
      humanApproved: !!row.approved_at,
      expiresAt: new Date(row.expires_at).toISOString(),
      reviewPath: this.reviewPath(id),
      retention: captureRetention,
      message:
        op.status === "pending"
          ? "Open the Idea Lab review link to approve the exact fields/source. Authentication and client approval flags do not grant this website consent."
          : "Check this operation's status before another capture. No canonical write was replayed.",
    };
  }
  async view(id: string, actor: string) {
    const status = await this.status(id, actor),
      { row, op } = await this.store.read(actor, id);
    if (
      op.status !== "pending" ||
      !row.command_json ||
      row.expires_at <= Date.now()
    )
      return { ...status, canApprove: false };
    const payload = await this.store.payload(row);
    let stale = false,
      before = null;
    if (payload.command.action === "update") {
      before = await this.repository.get(payload.command.id);
      stale =
        !!before.canonicalIdeaId ||
        before.revision !== payload.command.expectedRevision;
    }
    return {
      ...status,
      client: payload.client,
      command: payload.command,
      changes: reviewIdeaCommand(stale ? null : before, payload.command),
      canApprove: !stale,
      stale,
      message: stale
        ? "The canonical idea changed after this draft was prepared. Reject it and review a fresh update."
        : status.message,
    };
  }
  async save(id: string, actor: string) {
    await this.store.purge(actor);
    const { row, op } = await this.store.read(actor, id);
    if (op.status === "done") return this.status(id, actor);
    if (op.status !== "pending") return this.status(id, actor);
    if (row.expires_at <= Date.now())
      throw new AppError(
        "ASSISTANT_CAPTURE_EXPIRED",
        "This capture review expired. Check the prior operation before preparing a fresh request.",
        409,
      );
    if (!row.approved_at)
      throw new AppError(
        "HUMAN_APPROVAL_REQUIRED",
        "Open the Idea Lab review link and approve this exact draft first. The assistant cannot approve it for you.",
        409,
      );
    const payload = await this.store.payload(row),
      result = await this.writer().executeAssistantApproved(
        payload.command,
        id,
        actor,
      );
    await this.store.forget(actor, id);
    return {
      proposalId: id,
      status: "done",
      ideaId: result.idea.id,
      canonicalUrl: result.idea.url,
      reviewPath: this.reviewPath(id),
      message:
        "The approved idea is saved in Notion with its canonical link. Temporary draft content was cleared.",
    };
  }
  async approveAndSave(id: string, actor: string) {
    await this.store.purge(actor);
    const { op } = await this.store.read(actor, id);
    if (op.status === "done") return this.status(id, actor);
    await this.store.approve(actor, id);
    return this.save(id, actor);
  }
  async reject(id: string, actor: string) {
    await this.store.reject(actor, id);
    return this.status(id, actor);
  }
  async reconcile(id: string, actor: string) {
    await this.store.read(actor, id);
    await this.writer().reconcileId(id, actor);
    return this.status(id, actor);
  }
}
