import { authorizeOwner } from "@/lib/ideas/access";
import { uuid } from "@/lib/ideas/domain";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import {
  roundtableReportService,
  roundtableReports,
} from "@/lib/roundtable/access";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  try {
    const user = await authorizeOwner();
    const parsed = uuid.safeParse(
      new URL(request.url).searchParams.get("ideaId"),
    );
    if (!parsed.success)
      throw new AppError(
        "INVALID_IDEA",
        "Choose an idea to load saved assessments.",
        400,
      );
    await roundtableReports().get(parsed.data);
    return Response.json(
      { data: await roundtableReportService().list(parsed.data, user.userId) },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
