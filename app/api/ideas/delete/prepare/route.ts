import {
  authorizeOwner,
  checkOrigin,
  jsonBody,
  deletionService,
} from "@/lib/ideas/access";
import { deleteCommandSchema } from "@/lib/ideas/deletion";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = deleteCommandSchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_APPROVAL",
        "This deletion request is invalid.",
        400,
      );
    return Response.json(
      { data: await deletionService().prepare(parsed.data, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
