import { authorizeOwner, repository } from "@/lib/ideas/access";
import { errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await authorizeOwner();
    return Response.json(
      { data: await repository().reviews() },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
