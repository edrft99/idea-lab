import { authorizeOwner } from "@/lib/ideas/access";
import { errorResponse } from "@/lib/ideas/errors";
import { semanticCoordinator } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await authorizeOwner();
    return Response.json(
      { data: await semanticCoordinator().list(user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
