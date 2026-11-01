import { z } from "zod";
import { authorizeOwner, checkOrigin, jsonBody } from "@/lib/ideas/access";
import { AppError, errorResponse } from "@/lib/ideas/errors";

import { semanticCoordinator } from "@/lib/intelligence/semantic-access";
export const dynamic = "force-dynamic";

import { operationalDB } from "@/lib/ideas/runtime";
import { SemanticCache } from "@/lib/intelligence/semantic-cache";
import {
  embeddingConfig,
  embeddingProfile,
} from "@/lib/intelligence/embedding-config";
export async function GET() {
  try {
    const user = await authorizeOwner(),
      cache = new SemanticCache(operationalDB());
    await cache.purgeExpired(user.userId);
    let profile;
    try {
      profile = { enabled: true, ...embeddingProfile(embeddingConfig()) };
    } catch {
      profile = { enabled: false };
    }
    const state = await cache.snapshots.metadata(user.userId);
    return Response.json(
      {
        data: {
          ...profile,
          cache: await cache.stats(user.userId),
          snapshotCount: state.rows.length,
          activeSnapshotId: state.reference?.snapshot_id ?? null,
          activeUnavailable:
            !!state.reference &&
            !state.rows.some(
              (r) =>
                r.id === state.reference!.snapshot_id &&
                r.expires_at > Date.now(),
            ),
        },
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
export async function POST(request: Request) {
  try {
    const user = await authorizeOwner();
    checkOrigin(request);
    const parsed = z
      .object({ approvalToken: z.string().regex(/^[a-f0-9]{64}$/) })
      .strict()
      .safeParse(await jsonBody(request));
    if (!parsed.success)
      throw new AppError(
        "INVALID_OPERATION",
        "This semantic request reference is invalid.",
        400,
      );
    return Response.json(
      {
        data: await semanticCoordinator().statusToken(
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
