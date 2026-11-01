import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { assessmentStoreSchema } from "@/lib/evaluations/proposal-model";
import { assessmentService } from "@/lib/evaluations/proposal-access";
export const dynamic = "force-dynamic";
const schema = assessmentStoreSchema;
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request, 96000));
    if (!parsed.success)
      throw new AppError(
        "INVALID_PROPOSAL",
        "Review the selected proposal, decision and required reason.",
        400,
      );
    return Response.json(
      {
        data: await assessmentService().prepareStore(parsed.data, user.userId),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
