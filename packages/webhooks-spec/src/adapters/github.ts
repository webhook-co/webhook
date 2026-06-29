// GitHub verify adapter — the registry instance produced from GITHUB_CONFIG (./config). Header
// `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256 over the raw body, no signed timestamp. The
// recipe lives in the config; this named export is kept for the adapter's test suite.
// See https://docs.github.com/webhooks/securing-your-webhooks.

import { getAdapterForScheme } from "./registry";

export const githubAdapter = getAdapterForScheme("github")!;
