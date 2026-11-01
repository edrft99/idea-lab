import { authorizeOwner, repository } from "@/lib/ideas/access";
import { uuid } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await authorizeOwner();
    const { id } = await params;
    if (!uuid.safeParse(id).success)
      throw new AppError("NOT_FOUND", "This idea could not be found.", 404);
    return Response.json(
      { data: await repository().detail(id) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
