import { authorizeOwner } from "@/lib/ideas/access";
import { errorResponse } from "@/lib/ideas/errors";
import { gptProfile } from "@/lib/roundtable/access";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await authorizeOwner();
    let gpt;
    try {
      gpt = { enabled: true, profile: gptProfile() };
    } catch {
      gpt = {
        enabled: false,
        message:
          "GPT needs a connection. Add its provider, model, API key and retention notice in protected site settings.",
      };
    }
    return Response.json(
      { data: { gpt } },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
