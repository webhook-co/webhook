// GitHub verify adapter — produced from the declarative GITHUB_CONFIG (./config) via the
// shared `makeHmacAdapter` factory. Header `X-Hub-Signature-256: sha256=<hex>`, HMAC-SHA256
// over the raw body verbatim, no signed timestamp. The behavior (and its tests) are unchanged
// by the config migration; the crypto lives once in `verifyHmacCore`.
// See https://docs.github.com/webhooks/securing-your-webhooks.

import { GITHUB_CONFIG } from "./config";
import { makeHmacAdapter } from "./factory";

export const githubAdapter = makeHmacAdapter(GITHUB_CONFIG);
