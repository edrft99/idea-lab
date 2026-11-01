import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";

import { semanticCoordinator } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
import { clearCommandSchema } from "@/lib/intelligence/semantic-model";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    if (!clearCommandSchema.safeParse(await jsonBody(request)).success)
      throw new AppError(
        "INVALID_SEMANTIC_REQUEST",
        "Review clearing only your derived vectors.",
        400,
      );
    return Response.json(
      { data: await semanticCoordinator().prepareClear(user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
