import { authorizeOwner, repository } from "@/lib/ideas/access";
import { errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await authorizeOwner();
    const repo = repository();
    const [ideas, reviews] = await Promise.allSettled([
      repo.list({ sort: "score" }),
      repo.reviews(),
    ]);
    if (ideas.status === "rejected") throw ideas.reason;
    return Response.json(
      {
        data: {
          ideas: ideas.value,
          reviews: reviews.status === "fulfilled" ? reviews.value : [],
          reviewUnavailable: reviews.status === "rejected",
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
