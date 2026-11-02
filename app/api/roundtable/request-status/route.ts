import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { roundtableRequestStatus } from "@/lib/roundtable/service";
import { Operations } from "@/lib/ideas/operations";
import { operationalDB } from "@/lib/ideas/runtime";
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
        "INVALID_ROUNDTABLE_REQUEST",
        "Select evidence and define success criteria and constraints.",
        400,
      );
    return Response.json(
      {
        data: await roundtableRequestStatus(
          new Operations(operationalDB()),
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
