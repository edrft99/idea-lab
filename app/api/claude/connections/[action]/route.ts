import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { errorResponse, AppError } from "@/lib/ideas/errors";
import { claudeAuthService } from "@/lib/claude-auth/access";
import { decisionSchema, hashSchema } from "@/lib/claude-auth/model";
import { privateHeaders } from "@/lib/claude-auth/http";
import { z } from "zod";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    const actor = await authorizeOwner(),
      { action } = await params,
      service = claudeAuthService(new URL(request.url).origin);
    if (action === "sessions")
      return Response.json(
        { data: await service.sessions(actor) },
        { headers: privateHeaders },
      );
    return Response.json(
      { data: await service.review(hashSchema.parse(action), actor) },
      { headers: privateHeaders },
    );
  } catch (e) {
    return errorResponse(e);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    const actor = await authorizeOwner();
    checkOrigin(request);
    const { action } = await params,
      service = claudeAuthService(new URL(request.url).origin),
      input = await jsonBody(request, 6000);
    if (action === "decide") {
      const p = decisionSchema.parse(input);
      return Response.json(
        {
          data: await service.decide(
            p.requestId,
            p.decision,
            p.reviewHash,
            actor,
          ),
        },
        { headers: privateHeaders },
      );
    }
    if (action === "revoke") {
      const p = z.object({ sessionId: hashSchema }).strict().parse(input);
      await service.revokeOwned(p.sessionId, actor);
      return Response.json(
        { data: { revoked: true } },
        { headers: privateHeaders },
      );
    }
    throw new AppError(
      "NOT_FOUND",
      "This connection action is not available.",
      404,
    );
  } catch (e) {
    return errorResponse(e);
  }
}
