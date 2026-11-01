import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { errorResponse, AppError } from "@/lib/ideas/errors";
import { z } from "zod";
import { importJobStore } from "@/lib/imports/job-access";
export const dynamic = "force-dynamic";
const headers = { "Cache-Control": "private, no-store" };
export async function GET() {
  try {
    const actor = await authorizeOwner();
    return Response.json(
      { data: await importJobStore().list(actor.userId) },
      { headers },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const actor = await authorizeOwner();
    checkOrigin(request);
    const input = await jsonBody(request, 40000);
    return Response.json(
      { data: await importJobStore().create(input, actor.userId) },
      { headers },
    );
  } catch (error) {
    return errorResponse(
      error instanceof z.ZodError
        ? new AppError(
            "INVALID_IMPORT_JOB",
            "The job manifest is invalid. Send only selected item identifiers and checksums.",
            400,
          )
        : error,
    );
  }
}
