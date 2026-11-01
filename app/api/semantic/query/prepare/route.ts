import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { queryCommandSchema } from "@/lib/intelligence/semantic-model";
import { semanticService } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = queryCommandSchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_SEMANTIC_REQUEST",
        "Choose valid records, fields or a query and review transmission.",
        400,
      );
    return Response.json(
      { data: await semanticService().prepareQuery(parsed.data, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
