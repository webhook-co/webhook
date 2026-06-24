// The get.webhook.co request router (pure: URL + the install-script text → Response). Two jobs:
//   GET /  ·  /install.sh            → serve the wbhk installer (so `curl -fsSL https://get.webhook.co | sh`)
//   GET /<asset>  ·  /v<ver>/<asset> → 302 to the matching GitHub release asset
// Everything else 404s. Redirects are restricted to a FIXED asset allowlist + the canonical releases host,
// so there is no open-redirect: a caller can never steer the Location at an arbitrary destination.

const REPO = "webhook-co/webhook";
const RELEASES = `https://github.com/${REPO}/releases`;

// The published release-asset names (mirror packages/cli/scripts/release-build.mjs) + checksums.txt.
const ASSETS: ReadonlySet<string> = new Set([
  "wbhk-darwin-arm64",
  "wbhk-darwin-x64",
  "wbhk-linux-x64",
  "wbhk-linux-arm64",
  "wbhk-windows-x64.exe",
  "checksums.txt",
]);

// `v<semver>/<asset>` → a specific release tag (cli-v<semver>).
const VERSIONED = /^v(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\/(.+)$/;

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "x-content-type-options": "nosniff",
  // get.webhook.co only — host-scoped via the response header (no includeSubDomains, so it never bleeds
  // onto api./mcp./auth. on the shared zone; see the www CD notes).
  "strict-transport-security": "max-age=63072000",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "public, max-age=300", ...SECURITY_HEADERS },
  });
}

export function handleGet(url: URL, installScript: string): Response {
  if (url.pathname === "/" || url.pathname === "/install.sh") {
    return new Response(installScript, {
      headers: {
        "content-type": "text/x-shellscript; charset=utf-8",
        "cache-control": "public, max-age=300",
        ...SECURITY_HEADERS,
      },
    });
  }

  const path = url.pathname.replace(/^\/+/, "");
  if (ASSETS.has(path)) {
    return redirect(`${RELEASES}/latest/download/${path}`);
  }
  const m = VERSIONED.exec(path);
  if (m !== null && ASSETS.has(m[2] as string)) {
    return redirect(`${RELEASES}/download/cli-v${m[1]}/${m[2]}`);
  }

  return new Response("not found — see https://github.com/webhook-co/webhook/releases\n", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8", ...SECURITY_HEADERS },
  });
}
