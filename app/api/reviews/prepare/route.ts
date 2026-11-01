import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { decisionCommandSchema } from "@/lib/reviews/model";
import { reviewService } from "@/lib/reviews/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
const schema = decisionCommandSchema;
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = schema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_REVIEW",
        "Choose the records, decision and a reason before reviewing.",
        400,
      );
    const data = await reviewService().prepare(parsed.data, user.userId);
    return Response.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
