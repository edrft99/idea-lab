import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { uuid } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import {
  attachmentRepository,
  attachmentService,
  uploadBody,
} from "@/lib/attachments/access";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, context: Context) {
  try {
    const user = await authorizeOwner();
    const { action } = await context.params,
      id = new URL(request.url).searchParams.get("ideaId");
    if (action !== "list" || !uuid.safeParse(id).success)
      throw new AppError("NOT_FOUND", "Attachment collection not found.", 404);
    const attachments = await attachmentRepository().list(id!);
    const pending = await attachmentService().operations.pendingAttachments(
      user.userId,
      id!,
    );
    return Response.json({ data: { attachments, pending } }, { headers });
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request, context: Context) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const { action } = await context.params;
    if (action === "commit") {
      const { file, token } = await uploadBody(request);
      return Response.json(
        { data: await attachmentService().commit(user.userId, token, file) },
        { headers },
      );
    }
    if (action === "prepare")
      return Response.json(
        {
          data: await attachmentService().prepare(
            user.userId,
            await jsonBody(request, 2000),
          ),
        },
        { headers },
      );
    if (action === "status") {
      const parsed = z
        .object({ operationId: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .safeParse(await jsonBody(request, 1000));
      if (!parsed.success)
        throw new AppError(
          "INVALID_OPERATION",
          "This upload reference is invalid.",
          400,
        );
      return Response.json(
        {
          data: await attachmentService().status(
            user.userId,
            parsed.data.operationId,
          ),
        },
        { headers },
      );
    }
    throw new AppError("NOT_FOUND", "Attachment action not found.", 404);
  } catch (error) {
    return errorResponse(error);
  }
}
