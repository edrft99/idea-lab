import { authorizeOwner } from "@/lib/ideas/access";
import { uuid } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { assessmentRepository } from "@/lib/evaluations/proposal-access";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await authorizeOwner();
    const parsed = uuid.safeParse((await params).id);
    if (!parsed.success)
      throw new AppError("NOT_FOUND", "This proposal was not found.", 404);
    return Response.json(
      { data: await assessmentRepository().proposal(parsed.data) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
