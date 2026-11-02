import { z } from "zod";
import { AppError } from "./errors";
import { digest, Operations } from "./operations";
import { NotionRepository } from "./notion";

export const deleteCommandSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.string().min(1).max(300),
  })
  .strict();
type DeleteCommand = z.infer<typeof deleteCommandSchema>;
export class IdeaDeletion {
  constructor(
    private repository: NotionRepository,
    private operations: Operations,
  ) {}
  async prepare(input: DeleteCommand, actor: string) {
    const command = deleteCommandSchema.parse(input);
    const idea = await this.repository.get(command.id);
    if (idea.revision !== command.expectedRevision)
      throw new AppError(
        "STALE_IDEA",
        "This idea changed. Refresh before deleting it.",
        409,
      );
    if (
      idea.canonicalIdeaId ||
      (await this.repository.hasMergedHistory(command.id))
    )
      throw new AppError(
        "MERGED_IDEA",
        "Merged ideas preserve shared history and cannot be deleted here.",
        409,
      );
    const receipt = await this.operations.issue(
      actor,
      await digest(JSON.stringify(command)),
      "delete-idea",
      command.id,
      command.expectedRevision,
    );
    return {
      approvalToken: receipt.token,
      title: idea.title,
      expiresAt: new Date(receipt.expires).toISOString(),
    };
  }
  async commit(input: DeleteCommand, token: string, actor: string) {
    const command = deleteCommandSchema.parse(input);
    const op = await this.operations.read(token, actor);
    const hash = await digest(JSON.stringify(command));
    if (
      op.action !== "delete-idea" ||
      op.target !== command.id ||
      op.expected_revision !== command.expectedRevision ||
      op.payload_hash !== hash
    )
      throw new AppError(
        "INVALID_APPROVAL",
        "Review this exact deletion again.",
        409,
      );
    if (op.status === "done") return { deleted: true, ideaId: command.id };
    await this.operations.claim(op, hash);
    let attempted = false;
    try {
      const idea = await this.repository.get(command.id);
      if (
        idea.revision !== command.expectedRevision ||
        idea.canonicalIdeaId ||
        (await this.repository.hasMergedHistory(command.id))
      )
        throw new AppError(
          "STALE_IDEA",
          "This idea changed after review. Refresh before deleting it.",
          409,
        );
      attempted = true;
      await this.repository.trashIdea(command.id);
      await this.operations.finish(op.id, "done", command.id);
      return { deleted: true, ideaId: command.id };
    } catch (error) {
      const uncertain =
        attempted && (!(error instanceof AppError) || error.uncertain);
      try {
        await this.operations.finish(op.id, uncertain ? "uncertain" : "failed");
      } catch {
        // Keep the running operation and its lock available for status recovery.
      }
      if (uncertain)
        throw new AppError(
          "WRITE_UNCERTAIN",
          "Deletion could not be confirmed. Check status before trying again.",
          503,
          undefined,
          true,
        );
      throw error;
    }
  }
  async status(token: string, actor: string, byId = false) {
    const op = byId
      ? await this.operations.readById(token, actor)
      : await this.operations.read(token, actor);
    if (op.action !== "delete-idea" || !op.target)
      throw new AppError(
        "INVALID_OPERATION",
        "This is not an idea deletion.",
        400,
      );
    if (
      ["running", "uncertain"].includes(op.status) &&
      (await this.repository.page(op.target)).in_trash
    ) {
      await this.operations.finish(op.id, "done", op.target);
      return { status: "done", ideaId: op.target };
    }
    return {
      status: op.status,
      ideaId: op.status === "done" ? op.target : null,
    };
  }
}
