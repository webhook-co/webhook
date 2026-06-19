// auth.webhook.co — the identity surface (login / consent / device pages + Lane C's Better Auth runtime
// + the OAuth issuer route handlers), rendered on Cloudflare Workers via @opennextjs/cloudflare. Pure
// SSR, so no incremental-cache infra (empty config). See ADR-0021 (the OpenNext-on-Workers decision).
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
