import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { requestSchema } from "@/lib/roundtable/model";
import { roundtableService } from "@/lib/roundtable/access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({
        command: requestSchema,
        approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_ROUNDTABLE_REQUEST",
        "Select evidence and define success criteria and constraints.",
        400,
      );
    return Response.json(
      {
        data: await roundtableService().execute(
          parsed.data.command,
          parsed.data.approvalToken,
          user.userId,
          request.signal,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
