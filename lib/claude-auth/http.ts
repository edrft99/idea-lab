import { z } from "zod";
import { safeFailure } from "../ideas/errors";
export const privateHeaders = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
export function oauthFailure(error: unknown) {
  if (error instanceof z.ZodError)
    return Response.json(
      {
        error: "invalid_request",
        error_description:
          "The OAuth parameters do not match the supported request.",
      },
      { status: 400, headers: privateHeaders },
    );
  const e = safeFailure(error);
  const code =
    e.code === "INVALID_GRANT" || e.code === "REFRESH_REUSED"
      ? "invalid_grant"
      : e.code === "INVALID_TOKEN"
        ? "invalid_token"
        : e.code === "INSUFFICIENT_SCOPE"
          ? "insufficient_scope"
          : e.status >= 500
            ? "temporarily_unavailable"
            : "invalid_request";
  return Response.json(
    { error: code, error_description: e.message },
    { status: e.status, headers: privateHeaders },
  );
}
