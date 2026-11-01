import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { snapshotPlanSchema } from "@/lib/intelligence/snapshot-model";
import { snapshotService } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({
        command: snapshotPlanSchema,
        approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_SEMANTIC_REQUEST",
        "Choose a valid complete-snapshot command and review it again.",
        400,
      );
    return Response.json(
      {
        data: await snapshotService().plan(
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
