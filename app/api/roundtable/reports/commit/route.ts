import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { resultSchema } from "@/lib/roundtable/model";
import { roundtableReportService } from "@/lib/roundtable/access";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({
        result: resultSchema,
        approvalToken: z.string().regex(/^[a-f0-9]{64}$/),
      })
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
        data: await roundtableReportService().commit(
          parsed.data.result,
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
