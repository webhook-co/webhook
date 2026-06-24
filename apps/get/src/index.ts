// get.webhook.co — the install + download shim Worker (distribution DIST-5b). Redirects `/` + `/install.sh`
// to the canonical installer and asset paths to the GitHub release. All logic is in router.ts (pure,
// unit-tested); this entry is the thin Worker wiring. (The Worker is content-free — it embeds no shell
// script — so its upload isn't blocked by Cloudflare's API WAF; see router.ts.)
import { handleGet } from "./router.js";

export default {
  fetch(request: Request): Response {
    return handleGet(new URL(request.url));
  },
} satisfies ExportedHandler;
