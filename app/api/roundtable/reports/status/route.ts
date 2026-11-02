import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { roundtableReportService } from "@/lib/roundtable/access";
import { digest } from "@/lib/ideas/operations";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({ approvalToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(await jsonBody(request, 262144));
    if (!parsed.success)
      throw new AppError(
        "INVALID_REPORT",
        "Review a valid GPT report before saving.",
        400,
      );
    return Response.json(
      {
        data: await roundtableReportService().reconcile(
          await digest(parsed.data.approvalToken),
          user.userId,
        ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
