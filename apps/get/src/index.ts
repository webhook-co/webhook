// get.webhook.co — the install + download shim Worker (distribution DIST-5b). Serves the canonical
// packages/cli/scripts/install.sh (imported as a Text module so there is ONE source of truth — updating the
// installer redeploys this) and 302-redirects asset paths to the GitHub release. All logic is in router.ts
// (pure, unit-tested); this entry is the thin Worker wiring.
import installScript from "../../../packages/cli/scripts/install.sh";

import { handleGet } from "./router.js";

export default {
  fetch(request: Request): Response {
    return handleGet(new URL(request.url), installScript);
  },
} satisfies ExportedHandler;
