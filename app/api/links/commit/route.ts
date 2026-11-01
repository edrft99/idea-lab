import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { linkCommandSchema } from "@/lib/links/model";
import { linkService } from "@/lib/links/access";
export const dynamic = "force-dynamic";
const schema = z
  .object({
    command: linkCommandSchema,
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_LINK",
        "Choose two ideas, their current versions and a reason.",
        400,
      );
    return Response.json(
      {
        data: await linkService().execute(
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
