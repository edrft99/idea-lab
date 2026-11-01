import {
  authorizeOwner,
  checkOrigin,
  jsonBody,
  writeService,
} from "@/lib/ideas/access";
import { commandSchema } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = commandSchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_IDEA",
        "Check the idea fields before reviewing.",
        400,
      );
    return Response.json(
      { data: await writeService().prepare(parsed.data, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
