import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
import { resultSchema } from "@/lib/roundtable/model";
import { roundtableReportService } from "@/lib/roundtable/access";
import { digest } from "@/lib/ideas/operations";
export const dynamic = "force-dynamic";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .union([
        z.object({ approvalToken: hash }).strict(),
        z.object({ operationId: hash }).strict(),
        z.object({ result: resultSchema }).strict(),
      ])
      .safeParse(await jsonBody(request, 262144));
    if (!parsed.success)
      throw new AppError(
        "INVALID_REPORT",
        "Choose a valid assessment save to check.",
        400,
      );
    const data =
      "result" in parsed.data
        ? await roundtableReportService().recover(
            parsed.data.result,
            user.userId,
          )
        : await roundtableReportService().reconcile(
            "operationId" in parsed.data
              ? parsed.data.operationId
              : await digest(parsed.data.approvalToken),
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
