import { z } from "zod";
import {
  claudeAuthService,
  requireRelay,
  parameters,
  oauthForm,
} from "@/lib/claude-auth/access";
import { CLAUDE_CLIENT } from "@/lib/claude-auth/model";
import { privateHeaders, oauthFailure } from "@/lib/claude-auth/http";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ action: string }> };
export async function GET(request: Request, { params }: Context) {
  try {
    await requireRelay(request);
    const { action } = await params,
      service = claudeAuthService(new URL(request.url).origin);
    if (action === "metadata")
      return Response.json(service.metadata(), { headers: privateHeaders });
    if (action === "resource")
      return Response.json(service.resourceMetadata(), {
        headers: privateHeaders,
      });
    if (action === "authorize") {
      const state = await service.start(
        parameters(new URL(request.url).searchParams),
      );
      return new Response(null, {
        status: 302,
        headers: { ...privateHeaders, Location: state.consentUrl },
      });
    }
    return new Response(null, { status: 404, headers: privateHeaders });
  } catch (e) {
    return oauthFailure(e);
  }
}
export async function POST(request: Request, { params }: Context) {
  try {
    await requireRelay(request);
    const { action } = await params,
      service = claudeAuthService(new URL(request.url).origin),
      form = await oauthForm(request);
    if (action === "token")
      return Response.json(await service.exchange(form), {
        headers: privateHeaders,
      });
    if (action === "revoke") {
      const p = z
        .object({
          token: z.string().min(1).max(2000),
          client_id: z.literal(CLAUDE_CLIENT),
          token_type_hint: z.enum(["access_token", "refresh_token"]).optional(),
        })
        .strict()
        .parse(form);
      await service.revokeToken(p.token, p.client_id);
      return new Response(null, { status: 200, headers: privateHeaders });
    }
    return new Response(null, { status: 404, headers: privateHeaders });
  } catch (e) {
    return oauthFailure(e);
  }
}
