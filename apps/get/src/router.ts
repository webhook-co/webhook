// The get.webhook.co request router (pure: URL → Response). Two jobs:
//   GET /  ·  /install.sh            → 302 to the canonical install.sh (so `curl -fsSL https://get…  | sh`)
//   GET /<asset>  ·  /v<ver>/<asset> → 302 to the matching GitHub release asset
// Everything else 404s.
//
// We REDIRECT to the installer rather than embedding it: a Worker-script upload whose bundle contains the
// shell installer (`curl … | sh`, `rm -rf`, `xattr`, …) is blocked by Cloudflare's API WAF (an HTML 403 on
// the script PUT, from any origin). install.sh already depends on GitHub for the binaries, so serving it from
// the repo's raw URL adds no new dependency and keeps the Worker content-free. Redirect targets are a FIXED
// allowlist (the installer URL + the release assets) on canonical hosts → no open redirect.

const REPO = "webhook-co/webhook";
const RELEASES = `https://github.com/${REPO}/releases`;
// The canonical installer on the default branch (it self-resolves the latest release at runtime, so `main`
// is correct — the script is version-agnostic; the binaries it fetches are the latest published release).
const INSTALL_SH = `https://raw.githubusercontent.com/${REPO}/main/packages/cli/scripts/install.sh`;

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
  // get.webhook.co only — host-scoped (no includeSubDomains, so it never bleeds onto api./mcp./auth. on the
  // shared zone; see the www CD notes).
  "strict-transport-security": "max-age=63072000",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function redirect(location: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location, "cache-control": "public, max-age=300", ...SECURITY_HEADERS },
  });
}

export function handleGet(url: URL): Response {
  if (url.pathname === "/" || url.pathname === "/install.sh") {
    return redirect(INSTALL_SH);
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
