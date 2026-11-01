"use client";
import { useEffect, useState, useCallback } from "react";
export class ApiFailure extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
    public uncertain = false,
    public retryAfter?: number,
    public canonicalIdeaIds: string[] = [],
    public reviewIds: string[] = [],
  ) {
    super(message);
  }
}
export async function requestData<T>(
  url: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  let body: any;
  try {
    body = await response.json();
  } catch {
    throw new ApiFailure(
      "UNAVAILABLE",
      "The server returned an unreadable response.",
      response.status,
    );
  }
  if (!response.ok)
    throw new ApiFailure(
      body.error?.code ?? "UNAVAILABLE",
      body.error?.message ?? "This request could not be completed.",
      response.status,
      Boolean(body.error?.uncertain),
      Number(response.headers.get("Retry-After")) || undefined,
      Array.isArray(body.error?.canonicalIdeaIds)
        ? body.error.canonicalIdeaIds
            .filter(
              (id: unknown) =>
                typeof id === "string" && /^[a-f0-9-]{36}$/i.test(id),
            )
            .slice(0, 20)
        : [],
      Array.isArray(body.error?.reviewIds)?body.error.reviewIds.filter((id:unknown)=>typeof id==="string"&&/^[a-f0-9-]{36}$/i.test(id)).slice(0,20):[],
    );
  if (!Object.prototype.hasOwnProperty.call(body, "data"))
    throw new ApiFailure("UNAVAILABLE", "The response was incomplete.", 502);
  return body.data as T;
}
export function useResource<T>(url: string) {
  const [data, setData] = useState<T | null>(null),
    [error, setError] = useState<ApiFailure | null>(null),
    [loading, setLoading] = useState(true),
    [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((v) => v + 1), []);
  useEffect(() => {
    let current = true;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    requestData<T>(url, { signal: controller.signal })
      .then((value) => {
        if (current) setData(value);
      })
      .catch((e) => {
        if (current && e.name !== "AbortError")
          setError(
            e instanceof ApiFailure
              ? e
              : new ApiFailure(
                  "UNAVAILABLE",
                  "The request could not be completed.",
                  503,
                ),
          );
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
      controller.abort();
    };
  }, [url, revision]);
  return { data, error, loading, refresh, stale: Boolean(data && error) };
}
