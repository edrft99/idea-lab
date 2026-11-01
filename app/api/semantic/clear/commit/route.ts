import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";

import { semanticCoordinator } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
import { clearCommandSchema } from "@/lib/intelligence/semantic-model";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({
        command: clearCommandSchema,
        approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_SEMANTIC_REQUEST",
        "This cache clear approval is invalid.",
        400,
      );
    return Response.json(
      {
        data: await semanticCoordinator().clear(
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
