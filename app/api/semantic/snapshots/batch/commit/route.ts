import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { snapshotBatchSchema } from "@/lib/intelligence/snapshot-model";
import { snapshotService } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({
        command: snapshotBatchSchema,
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
        data: await snapshotService().batch(
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
