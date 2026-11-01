import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { assistantCaptureService } from "@/lib/assistant-capture/access";
import { captureChoiceSchema } from "@/lib/assistant-capture/model";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = captureChoiceSchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_CAPTURE",
        "This capture review reference is invalid.",
        400,
      );
    return Response.json(
      {
        data: await assistantCaptureService().reject(
          parsed.data.proposalId,
          user.userId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
