import { z } from "zod";
import {
  authorizeOwner,
  checkOrigin,
  jsonBody,
  deletionService,
} from "@/lib/ideas/access";
import { deleteCommandSchema } from "@/lib/ideas/deletion";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({
        command: deleteCommandSchema,
        approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_APPROVAL",
        "This deletion request is invalid.",
        400,
      );
    return Response.json(
      {
        data: await deletionService().commit(
          parsed.data.command,
          parsed.data.approvalToken,
          user.userId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
