// RFC 8707 audience resolution for the issuer. The requested `resource` must resolve to EXACTLY ONE of the
// permitted audiences — never defaulted, never widened. We canonicalize a single trailing slash before the
// exact match: the official MCP SDK derives `resource` via `new URL(prm.resource).href`, and the WHATWG URL
// parser appends `/` to an authority-only URI, so every SDK-based client (Claude Code, Claude Desktop, …)
// sends `resource=https://mcp.webhook.co/` while our canonical audience is the path-less
// `https://mcp.webhook.co`. The MCP spec itself notes the two forms are equivalent and the no-slash form is
// canonical, so we collapse the slash and seal the CANONICAL value — which the mint, the refresh path, and
// the MCP server's audience check all already compare against, keeping the whole chain consistent.

/** Normalize `resource` to exactly one value (a lone string, or a single-element array), else null. */
function singleResource(resource: string | string[] | undefined): string | null {
  if (typeof resource === "string") return resource;
  if (Array.isArray(resource) && resource.length === 1) return resource[0]!;
  return null;
}

/**
 * Resolve the requested `resource` to a permitted audience, or null if it isn't exactly one of them. Returns
 * the CANONICAL audience string (the value as it appears in `allowed`), so the sealed/minted audience always
 * matches what every downstream gate compares against. Tolerates a single trailing slash on the request (the
 * MCP-SDK normalization) but nothing more — a non-permitted origin still resolves to null.
 */
export function resolveAudience(
  resource: string | string[] | undefined,
  allowed: readonly string[],
): string | null {
  const value = singleResource(resource);
  if (value === null) return null;
  if (allowed.includes(value)) return value;
  // The MCP SDK sends the audience with a trailing slash (new URL(origin).href). Strip ONE and re-match
  // against the canonical (path-less) allowed value; return the canonical form, not the slashed request.
  if (value.endsWith("/")) {
    const stripped = value.slice(0, -1);
    if (allowed.includes(stripped)) return stripped;
  }
  return null;
}
