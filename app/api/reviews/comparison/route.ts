import { authorizeOwner } from "@/lib/ideas/access";
import { pairQuerySchema } from "@/lib/reviews/model";
import { reviewRepository } from "@/lib/reviews/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    await authorizeOwner();
    const parsed = pairQuerySchema.safeParse(
      Object.fromEntries(new URL(request.url).searchParams),
    );
    if (!parsed.success)
      throw new AppError(
        "INVALID_PAIR",
        "Choose two different saved ideas.",
        400,
      );
    return Response.json(
      {
        data: await reviewRepository().context(
          parsed.data.candidateId,
          parsed.data.matchingId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
