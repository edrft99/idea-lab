import { authorizeOwner, repository } from "@/lib/ideas/access";
import { filtersSchema } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await authorizeOwner();
    const parsed = filtersSchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      throw new AppError("INVALID_FILTER", "Check the search filters.", 400);
    return Response.json(
      { data: await repository().list(parsed.data) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
