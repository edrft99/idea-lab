import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import {
  storeProposalSchema,
  proposalDecisionSchema,
} from "@/lib/proposals/model";
import { proposalService } from "@/lib/proposals/access";
export const dynamic = "force-dynamic";
const schema = z
  .object({ approvalToken: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_PROPOSAL",
        "Review the selected proposal, decision and required reason.",
        400,
      );
    return Response.json(
      {
        data: await proposalService().reconcileToken(
          parsed.data.approvalToken,
          user.userId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
