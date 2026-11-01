import { getMcp, postMcp } from "@/lib/mcp/transport";
import {
  requireRelay,
  claudeAuthService,
  bearer,
} from "@/lib/claude-auth/access";
import { oauthFailure } from "@/lib/claude-auth/http";
export const dynamic = "force-dynamic";
async function authenticate(request: Request) {
  await requireRelay(request);
  return claudeAuthService(new URL(request.url).origin).authenticate(
    bearer(request),
  );
}
export async function GET(request: Request) {
  return getMcp(request, authenticate);
}
export async function POST(request: Request) {
  try {
    await requireRelay(request);
    return await postMcp(request, authenticate, "Claude");
  } catch (e) {
    return oauthFailure(e);
  }
}
