import { digest, Operations } from "../ideas/operations";
import { AppError } from "../ideas/errors";
import { AttachmentRepository } from "./repository";
import {
  contentType,
  inspectFile,
  prepareSchema,
  verifyImageSignature,
  type FileMetadata,
} from "./model";

const action = "attach-file";
const hash = (ideaId: string, file: FileMetadata) =>
  digest(JSON.stringify({ ideaId, file }));
export class AttachmentService {
  constructor(
    readonly repository: AttachmentRepository,
    readonly operations: Operations,
  ) {}
  async prepare(actor: string, raw: unknown) {
    const parsed = prepareSchema.safeParse(raw);
    if (!parsed.success)
      throw new AppError(
        "FILE_INVALID",
        "Choose a supported file of at most 5 MB with a plain filename.",
        400,
      );
    const { ideaId, file } = parsed.data;
    contentType(file.name);
    const idea = await this.repository.ideas.getSemanticIdea(ideaId);
    if (idea.canonicalIdeaId)
      throw new AppError(
        "IDEA_MERGED",
        "Add attachments to the surviving idea.",
        409,
      );
    const approval = await this.operations.issue(
      actor,
      await hash(ideaId, file),
      action,
      ideaId,
      idea.revision,
    );
    return {
      approvalToken: approval.token,
      operationId: approval.id,
      expires: approval.expires,
      ideaId,
      title: idea.title,
      file,
      contentType: contentType(file.name),
    };
  }
  async commit(actor: string, token: string, file: File) {
    const op = await this.operations.read(token, actor);
    if (op.action !== action || !op.target)
      throw new AppError(
        "INVALID_APPROVAL",
        "This is not an attachment approval.",
        400,
      );
    const metadata = await inspectFile(file),
      payload = await hash(op.target, metadata);
    verifyImageSignature(
      metadata.name,
      new Uint8Array(await file.arrayBuffer()),
    );
    if (payload !== op.payload_hash)
      throw new AppError(
        "APPROVAL_CHANGED",
        "The selected file changed. Review it again.",
        409,
      );
    if (op.status === "done") return this.status(actor, op.id);
    if (!(await this.operations.claim(op, payload)))
      return this.status(actor, op.id);
    let dispatched = false;
    try {
      const idea = await this.repository.ideas.getSemanticIdea(op.target);
      if (idea.canonicalIdeaId || idea.revision !== op.expected_revision)
        throw new AppError(
          "IDEA_CHANGED",
          "The idea changed after review. Review the attachment again.",
          409,
        );
      const uploadId = await this.repository.upload(file, metadata);
      // Uploading may take time. Recheck the target immediately before canonical attachment.
      const current = await this.repository.ideas.getSemanticIdea(op.target);
      if (current.canonicalIdeaId || current.revision !== op.expected_revision)
        throw new AppError(
          "IDEA_CHANGED",
          "The idea changed during upload. No attachment was added; review again.",
          409,
        );
      dispatched = true;
      const attachment = await this.repository.append(
        op.target,
        uploadId,
        metadata,
        op.id,
      );
      await this.operations.finishRunning(op.id, "done", attachment.id);
      return { status: "done", attachment };
    } catch (error) {
      // Never replay an ambiguous append. A later status check can only confirm a positive receipt.
      if (dispatched && (!(error instanceof AppError) || error.uncertain)) {
        await this.operations.finish(op.id, "uncertain");
        throw new AppError(
          "ATTACHMENT_UNCERTAIN",
          "The attachment was not confirmed. Use Check upload; do not upload it again until its outcome is verified.",
          503,
          undefined,
          true,
        );
      }
      await this.operations.finishRunning(op.id, "failed");
      throw error;
    }
  }
  async status(actor: string, operationId: string) {
    const op = await this.operations.readById(operationId, actor);
    if (op.action !== action || !op.target)
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an attachment operation.",
        400,
      );
    await this.repository.ideas.getSemanticIdea(op.target);
    if (
      op.status === "pending" ||
      op.status === "failed" ||
      op.status === "cancelled"
    )
      return { status: op.status, attachment: null };
    const attachment = await this.repository.find(op.target, op.id);
    if (attachment) {
      await this.operations.confirmAttachment(op.id, attachment.id);
      return { status: "done", attachment };
    }
    return {
      status: op.status === "done" ? "missing" : "uncertain",
      attachment: null,
    };
  }
}
