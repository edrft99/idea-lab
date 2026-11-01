import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { Operations } from "@/lib/ideas/operations";
import { operationalDB } from "@/lib/ideas/runtime";
import { aiRequestStatus } from "@/lib/intelligence/service";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({ approvalToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_AI_REQUEST",
        "This AI request reference is invalid.",
        400,
      );
    return Response.json(
      {
        data: aiRequestStatus(
          await new Operations(operationalDB()).read(
            parsed.data.approvalToken,
            user.userId,
          ),
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
