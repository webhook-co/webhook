// The dashboard (app.webhook.co) is a dynamic, auth-gated Next app rendered on Cloudflare Workers via
// `@opennextjs/cloudflare`. It is pure SSR (no ISR / `use cache`), so it needs NO incremental-cache
// infrastructure (no R2 cache bucket, no DO queue, no D1 tag cache) — the default config is empty.
// Verified in workerd by the E0 spike: a `cookies()` DAL gate redirects/renders correctly, no
// middleware/`proxy.ts` (unsupported by the adapter, and unneeded — Next 16 recommends gating in the
// data-access layer). See docs/adr (platform) for the runtime decision.
import { defineCloudflareConfig } from "@opennextjs/cloudflare";

export default defineCloudflareConfig({});
