import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { assessmentDecisionSchema } from "@/lib/evaluations/proposal-model";
import { assessmentService } from "@/lib/evaluations/proposal-access";
export const dynamic = "force-dynamic";
const schema = z
  .object({
    command: assessmentDecisionSchema,
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
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
        data: await assessmentService().decide(
          parsed.data.command,
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
