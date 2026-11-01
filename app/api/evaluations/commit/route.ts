import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { evaluationCommandSchema } from "@/lib/evaluations/model";
import { evaluationService } from "@/lib/evaluations/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
const schema = z
  .object({
    command: evaluationCommandSchema,
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
        "INVALID_EVALUATION",
        "Complete the ratings, evidence and review fields.",
        400,
      );
    const data = await evaluationService().execute(
      parsed.data.command,
      parsed.data.approvalToken,
      user.userId,
    );
    return Response.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
