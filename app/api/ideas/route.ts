import { scoredIdeas } from "@/lib/roundtable/scored-ideas";
import { filterIdeas } from "@/lib/ideas/domain";
import { authorizeOwner, repository } from "@/lib/ideas/access";
import { filtersSchema } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await authorizeOwner();
    const parsed = filtersSchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      throw new AppError("INVALID_FILTER", "Check the search filters.", 400);
    return Response.json(
      {
        data: filterIdeas(
          await scoredIdeas(
            await repository().list({ ...parsed.data, minScore: undefined }),
            user.userId,
          ),
          parsed.data,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
