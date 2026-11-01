import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { errorResponse, AppError } from "@/lib/ideas/errors";
import { importJobService, importJobStore } from "@/lib/imports/job-access";
import { jobId, jobHash, importCommand } from "@/lib/imports/job-model";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string; action: string }> };
const headers = { "Cache-Control": "private, no-store" };
const prepare = z.object({ itemId: jobId, command: importCommand }).strict();
const commit = prepare.extend({ approvalToken: jobHash });
export async function GET(_request: Request, { params }: Context) {
  try {
    const actor = await authorizeOwner(),
      p = await params;
    if (p.action !== "status")
      throw new AppError(
        "NOT_FOUND",
        "This import action is unavailable.",
        404,
      );
    return Response.json(
      { data: await importJobStore().view(p.id, actor.userId) },
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const actor = await authorizeOwner();
    checkOrigin(request);
    const { id, action } = await params,
      input = await jsonBody(request, 60000);
    let data: unknown;
    if (["pause", "cancel", "resume"].includes(action)) {
      z.object({}).strict().parse(input);
      data = await importJobStore().control(
        id,
        actor.userId,
        action as "pause" | "cancel" | "resume",
      );
    } else if (action === "prepare" || action === "recover-review") {
      const p = prepare.parse(input);
      data =
        action === "prepare"
          ? await importJobService().prepare(
              id,
              p.itemId,
              actor.userId,
              p.command,
            )
          : await importJobService().prepareRecovery(
              id,
              p.itemId,
              actor.userId,
              p.command,
            );
    } else if (action === "commit" || action === "recover") {
      const p = commit.parse(input);
      data =
        action === "commit"
          ? await importJobService().commit(
              id,
              p.itemId,
              actor.userId,
              p.command,
              p.approvalToken,
            )
          : await importJobService().recover(
              id,
              p.itemId,
              actor.userId,
              p.command,
              p.approvalToken,
            );
    } else if (action === "check") {
      const p = z.object({ itemId: jobId }).strict().parse(input);
      data = await importJobService().inspect(id, p.itemId, actor.userId);
    } else
      throw new AppError(
        "NOT_FOUND",
        "This import action is unavailable.",
        404,
      );
    return Response.json({ data }, { headers });
  } catch (error) {
    return errorResponse(
      error instanceof z.ZodError
        ? new AppError(
            "INVALID_IMPORT_JOB",
            "This import action does not match the required fields.",
            400,
          )
        : error,
    );
  }
}
