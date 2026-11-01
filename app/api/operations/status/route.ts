import { z } from "zod";
import {
  authorizeOwner,
  checkOrigin,
  jsonBody,
  writeService,
} from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const data = z
      .object({ approvalToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(await jsonBody(request));
    if (!data.success)
      throw new AppError(
        "INVALID_APPROVAL",
        "The operation reference is invalid.",
        400,
      );
    return Response.json(
      {
        data: await writeService().reconcile(
          data.data.approvalToken,
          user.userId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
