import { semanticCoordinator } from "@/lib/intelligence/semantic-access";
import { attachmentService } from "@/lib/attachments/access";
import { aiRequestStatus } from "@/lib/intelligence/service";
import { assessmentService } from "@/lib/evaluations/proposal-access";
import { proposalService } from "@/lib/proposals/access";
import { mergeService } from "@/lib/merges/access";
import { linkService } from "@/lib/links/access";
import { reviewService } from "@/lib/reviews/access";
import { Operations } from "@/lib/ideas/operations";
import { operationalDB } from "@/lib/ideas/runtime";
import { evaluationService } from "@/lib/evaluations/access";
import { z } from "zod";
import {
  deletionService,
  authorizeOwner,
  checkOrigin,
  jsonBody,
  writeService,
} from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";
export const dynamic = "force-dynamic";
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({ operationId: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_OPERATION",
        "This save reference is invalid.",
        400,
      );
    const operation = await new Operations(operationalDB()).readById(
      parsed.data.operationId,
      user.userId,
    );
    if (operation.action === "attach-file")
      return Response.json(
        {
          data: await attachmentService().status(
            user.userId,
            parsed.data.operationId,
          ),
        },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    return Response.json(
      {
        data:
          operation.action === "delete-idea"
            ? await deletionService().status(
                parsed.data.operationId,
                user.userId,
                true,
              )
            : operation.action.startsWith("semantic-")
              ? await semanticCoordinator().reconcile(
                  parsed.data.operationId,
                  user.userId,
                )
              : ["ai-evaluate", "ai-extract", "roundtable-gpt"].includes(
                    operation.action,
                  )
                ? aiRequestStatus(operation)
                : operation.action.startsWith("assessment-")
                  ? await assessmentService().reconcile(
                      parsed.data.operationId,
                      user.userId,
                    )
                  : operation.action.startsWith("proposal-")
                    ? await proposalService().reconcile(
                        parsed.data.operationId,
                        user.userId,
                      )
                    : operation.action === "merge-ideas"
                      ? await mergeService().reconcile(
                          parsed.data.operationId,
                          user.userId,
                        )
                      : operation.action === "related-link"
                        ? await linkService().reconcile(
                            parsed.data.operationId,
                            user.userId,
                          )
                        : operation.action.startsWith("evaluation-")
                          ? await evaluationService().reconcile(
                              parsed.data.operationId,
                              user.userId,
                            )
                          : operation.action === "review-decision"
                            ? await reviewService().reconcile(
                                parsed.data.operationId,
                                user.userId,
                              )
                            : await writeService().reconcileId(
                                parsed.data.operationId,
                                user.userId,
                              ),
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
