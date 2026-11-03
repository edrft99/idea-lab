import { scoredIdeas } from "@/lib/roundtable/scored-ideas";
import { authorizeOwner, repository } from "@/lib/ideas/access";
import { uuid } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await authorizeOwner();
    const { id } = await params;
    if (!uuid.safeParse(id).success)
      throw new AppError("NOT_FOUND", "This idea could not be found.", 404);
    const detail = await repository().detail(id);
    const scores = await scoredIdeas(
      [detail.idea, ...(detail.mergedIdeas ?? [])],
      user.userId,
    );
    return Response.json(
      { data: { ...detail, idea: scores[0], mergedIdeas: scores.slice(1) } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
