import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";

import { semanticCoordinator } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
import { Operations } from "@/lib/ideas/operations";
import { operationalDB } from "@/lib/ideas/runtime";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .union([
        z.object({ operationId: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
        z
          .object({ approvalToken: z.string().regex(/^[a-f0-9]{64}$/) })
          .strict(),
      ])
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_OPERATION",
        "This semantic operation is invalid.",
        400,
      );
    const id =
      "operationId" in parsed.data
        ? parsed.data.operationId
        : (
            await new Operations(operationalDB()).read(
              parsed.data.approvalToken,
              user.userId,
            )
          ).id;
    return Response.json(
      { data: await semanticCoordinator().cancel(id, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
