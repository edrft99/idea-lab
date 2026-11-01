// @ts-check
/** @typedef {{IDEA_LAB_SITE_ORIGIN?:string,IDEA_LAB_CLAUDE_RELAY_KEY?:string,IDEA_LAB_SITE_SERVICE_TOKEN?:string}} RelayEnv */
const headers = {
  "Cache-Control": "private, no-store",
  Pragma: "no-cache",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
/** @param {string} value */
function httpsOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== "https:" || u.origin !== value)
    throw new Error("Invalid relay configuration");
  return u.origin;
}
/** @param {ReadableStream<Uint8Array>|null} stream @param {number} maximum */
async function bounded(stream, maximum) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader(),
    chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > maximum) {
      await reader.cancel();
      throw new Error("Body limit exceeded");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}
/** @param {string} error @param {number} status */
const failed = (error, status) => Response.json({ error }, { status, headers });
/** @param {Request} request @param {RelayEnv} env @param {typeof fetch} fetcher */
export async function relay(request, env, fetcher = fetch) {
  try {
    const url = new URL(request.url),
      publicOrigin = httpsOrigin(url.origin),
      site = httpsOrigin(env.IDEA_LAB_SITE_ORIGIN ?? ""),
      key = env.IDEA_LAB_CLAUDE_RELAY_KEY ?? "",
      service = env.IDEA_LAB_SITE_SERVICE_TOKEN ?? "";
    if (
      publicOrigin === site ||
      key.length < 43 ||
      key.length > 128 ||
      !service
    )
      return failed("relay_not_configured", 503);
    const origin = request.headers.get("Origin");
    if (origin && ![publicOrigin, "https://claude.ai"].includes(origin))
      return failed("invalid_origin", 403);
    if (request.method === "GET" && url.pathname === "/")
      return new Response(
        "Idea Lab Claude connector. Connect using /api/claude/mcp. Authorization requires the private Idea Lab owner; no idea data is available anonymously.",
        {
          headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
        },
      );
    const paths = new Map([
      ["/.well-known/oauth-authorization-server", "metadata"],
      ["/.well-known/oauth-protected-resource", "resource"],
      ["/.well-known/oauth-protected-resource/api/claude/mcp", "resource"],
      ["/oauth/resource", "resource"],
      ["/authorize", "authorize"],
      ["/token", "token"],
      ["/revoke", "revoke"],
      ["/api/claude/mcp", "mcp"],
    ]);
    const action = paths.get(url.pathname);
    if (!action) return failed("not_found", 404);
    const methods =
      action === "mcp"
        ? ["GET", "POST"]
        : ["token", "revoke"].includes(action)
          ? ["POST"]
          : ["GET"];
    if (!methods.includes(request.method))
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: methods.join(", ") },
      });
    if (action !== "authorize" && url.search)
      return failed("query_parameters_not_allowed", 400);
    const upstream = new URL(
      action === "mcp" ? "/api/claude/mcp" : "/api/claude/auth/" + action,
      site,
    );
    if (action === "authorize") upstream.search = url.search;
    const forwarded = new Headers({
      "OAI-Sites-Authorization": "Bearer " + service,
      "X-Idea-Lab-Relay-Key": key,
    });
    for (const name of [
      "Accept",
      "Content-Type",
      "MCP-Protocol-Version",
      "Mcp-Method",
      "Mcp-Name",
      "Origin",
    ]) {
      const v = request.headers.get(name);
      if (v) forwarded.set(name, v);
    }
    const auth = request.headers.get("Authorization");
    if (action === "mcp" && auth)
      forwarded.set("X-Idea-Lab-Claude-Authorization", auth);
    const body =
      request.method === "POST"
        ? await bounded(request.body, 96000)
        : undefined;
    const response = await fetcher(upstream, {
      method: request.method,
      headers: forwarded,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(action === "mcp" ? 25000 : 8000),
    });
    const out = new Headers(headers);
    out.set(
      "Content-Type",
      response.headers.get("Content-Type") ?? "application/json",
    );
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("Location");
      if (action !== "authorize" || !location)
        return failed("invalid_upstream_redirect", 502);
      const redirect = new URL(location);
      if (
        redirect.origin !== site ||
        !/^\/claude\/connect\/[a-f0-9]{64}$/.test(redirect.pathname) ||
        redirect.search ||
        redirect.hash
      )
        return failed("invalid_upstream_redirect", 502);
      out.set("Location", redirect.href);
      return new Response(null, { status: 302, headers: out });
    }
    if (response.status === 401 && action === "mcp")
      out.set(
        "WWW-Authenticate",
        'Bearer resource_metadata="' +
          publicOrigin +
          '/oauth/resource", scope="ideas:read ideas:capture"',
      );
    const bytes = await bounded(response.body, 262144);
    return new Response(bytes.length ? bytes : null, {
      status: response.status,
      headers: out,
    });
  } catch {
    return failed("relay_temporarily_unavailable", 503);
  }
}
export default {
  /** @param {Request} request @param {RelayEnv} env */
  fetch(request, env) {
    return relay(request, env);
  },
};
