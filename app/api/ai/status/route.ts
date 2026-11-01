import { authorizeOwner } from "@/lib/ideas/access";
import { errorResponse } from "@/lib/ideas/errors";
import { aiConfig, aiProfile } from "@/lib/intelligence/config";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await authorizeOwner();
    let data;
    try {
      data = { enabled: true, ...aiProfile(aiConfig()) };
    } catch {
      data = {
        enabled: false,
        message:
          "AI requests are not configured. Manual capture, evaluation and proposal review remain available.",
      };
    }
    return Response.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
