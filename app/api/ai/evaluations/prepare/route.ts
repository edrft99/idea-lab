import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { aiEvaluationRequestSchema } from "@/lib/intelligence/model";
import { aiAssessmentService } from "@/lib/intelligence/access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = aiEvaluationRequestSchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_AI_REQUEST",
        "Choose and review the selected excerpts and scoring rubric.",
        400,
      );
    return Response.json(
      { data: await aiAssessmentService().prepare(parsed.data, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
