import { authorizeOwner } from "@/lib/ideas/access";
import { errorResponse } from "@/lib/ideas/errors";
import { assistantCaptureService } from "@/lib/assistant-capture/access";
import { captureId } from "@/lib/assistant-capture/model";
export const dynamic = "force-dynamic";
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const user = await authorizeOwner(),
      { id } = await params;
    return Response.json(
      {
        data: await assistantCaptureService().view(
          captureId.parse(id),
          user.userId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
