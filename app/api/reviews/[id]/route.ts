import { authorizeOwner } from "@/lib/ideas/access";
import { uuid } from "@/lib/ideas/domain";
import { reviewRepository } from "@/lib/reviews/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await authorizeOwner();
    const { id } = await params,
      parsed = uuid.safeParse(id);
    if (!parsed.success)
      throw new AppError("NOT_FOUND", "This review reference is invalid.", 404);
    return Response.json(
      { data: await reviewRepository().contextForReview(parsed.data) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
