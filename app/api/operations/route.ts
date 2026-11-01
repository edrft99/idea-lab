import { authorizeOwner } from "@/lib/ideas/access";
import { Operations } from "@/lib/ideas/operations";
import { operationalDB } from "@/lib/ideas/runtime";
import { errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    const user = await authorizeOwner();
    return Response.json(
      { data: await new Operations(operationalDB()).recent(user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
