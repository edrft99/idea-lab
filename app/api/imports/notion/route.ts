import {
  authorizeOwner,
  checkOrigin,
  jsonBody,
  repository,
} from "@/lib/ideas/access";
import { errorResponse, AppError } from "@/lib/ideas/errors";
import { notionSelectionSchema } from "@/lib/imports/notion-model";
import { NotionSelectionReader } from "@/lib/imports/notion-collector";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    await authorizeOwner();
    checkOrigin(request);
    const parsed = notionSelectionSchema.safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_NOTION_SELECTION",
        "Choose a valid Notion page or data source and explicitly select content to preview.",
        400,
      );
    const command = parsed.data,
      reader = new NotionSelectionReader(repository());
    const data =
      command.action === "list"
        ? {
            kind: "rows",
            result: await reader.list(command.reference, command.cursor),
          }
        : {
            kind: "preview",
            result:
              command.action === "page"
                ? await reader.pages([command.reference], command.readNested)
                : await reader.pages(
                    command.pageIds,
                    command.readNested,
                    command.dataSourceId,
                  ),
          };
    return Response.json(
      { data },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
