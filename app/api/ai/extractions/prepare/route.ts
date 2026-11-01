import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { aiExtractionRequestSchema } from "@/lib/intelligence/extraction-model";
import { aiExtractionService } from "@/lib/intelligence/extraction-access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = aiExtractionRequestSchema.safeParse(
      await jsonBody(request, 96000),
    );
    if (!parsed.success)
      throw new AppError(
        "INVALID_AI_REQUEST",
        "Choose and review the selected excerpts and scoring rubric.",
        400,
      );
    return Response.json(
      { data: await aiExtractionService().prepare(parsed.data, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
