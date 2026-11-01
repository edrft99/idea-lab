import { getMcp, postMcp } from "@/lib/mcp/transport";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return getMcp(request);
}
export async function POST(request: Request) {
  return postMcp(request);
}
