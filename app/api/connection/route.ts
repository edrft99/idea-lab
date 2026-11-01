import { authorizeOwner, repository } from "@/lib/ideas/access";
import { configurationStatus, operationalDB } from "@/lib/ideas/runtime";
import { errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function GET() {
  try {
    await authorizeOwner();
    const repo = repository();
    await Promise.all([
      repo.schema(repo.config.ideas),
      repo.schema(repo.config.sources),
      repo.schema(repo.config.evaluations),
      repo.schema(repo.config.reviews),
    ]);
    let writeLedger = false;
    try {
      await operationalDB()
        .prepare("SELECT id FROM idea_lab_operations LIMIT 1")
        .first();
      writeLedger = true;
    } catch {}
    return Response.json(
      {
        data: {
          ...configurationStatus(),
          readsVerified: true,
          writeLedger,
          writesVerified: false,
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
