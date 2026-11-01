import { z } from "zod";
import {
  authorizeOwner,
  checkOrigin,
  jsonBody,
  writeService,
} from "@/lib/ideas/access";
import { commandSchema } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
const bodySchema = z
  .object({
    command: commandSchema,
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = bodySchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_APPROVAL",
        "The save request is invalid.",
        400,
      );
    return Response.json(
      {
        data: await writeService().execute(
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
