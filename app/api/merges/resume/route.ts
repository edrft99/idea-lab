import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { mergeCommandSchema } from "@/lib/merges/model";
import { mergeService } from "@/lib/merges/access";
export const dynamic = "force-dynamic";
const schema = z
  .object({ operationId: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_MERGE",
        "Choose a survivor, distinct candidates, current versions and a preservation acknowledgment.",
        400,
      );
    return Response.json(
      {
        data: await mergeService().resume(parsed.data.operationId, user.userId),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
