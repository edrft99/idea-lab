export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 503,
    public retryAfter?: number,
    public uncertain = false,
    public canonicalIdeaIds: string[] = [],
    public reviewIds: string[] = [],
  ) {
    super(message);
  }
}
export function safeFailure(error: unknown) {
  return error instanceof AppError
    ? error
    : new AppError(
        "UNAVAILABLE",
        "This request could not be completed. Try again later.",
      );
}
export function errorResponse(error: unknown) {
  const e = safeFailure(error),
    requestId = crypto.randomUUID();
  console.error(
    JSON.stringify({
      event: "idea_request_failed",
      requestId,
      code: e.code,
      status: e.status,
    }),
  );
  return Response.json(
    {
      error: {
        code: e.code,
        message: e.message,
        requestId,
        uncertain: e.uncertain,
        reviewIds: e.reviewIds.filter(id=>/^[a-f0-9-]{36}$/i.test(id)).slice(0,20),
        canonicalIdeaIds: e.canonicalIdeaIds
          .filter((id) => /^[a-f0-9-]{36}$/i.test(id))
          .slice(0, 20),
      },
    },
    {
      status: e.status,
      headers: {
        "Cache-Control": "private, no-store",
        ...(e.retryAfter !== undefined
          ? { "Retry-After": String(e.retryAfter) }
          : {}),
      },
    },
  );
}
