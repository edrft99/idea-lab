import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { aiExtractionRequestSchema } from "@/lib/intelligence/extraction-model";
import { aiExtractionService } from "@/lib/intelligence/extraction-access";
export const dynamic = "force-dynamic";
const schema = z
  .object({
    command: aiExtractionRequestSchema,
    approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request, 96000));
    if (!parsed.success)
      throw new AppError(
        "INVALID_AI_REQUEST",
        "This AI consent request is invalid.",
        400,
      );
    return Response.json(
      {
        data: await aiExtractionService().execute(
          parsed.data.command,
          parsed.data.approvalToken,
          user.userId,
          request.signal,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
