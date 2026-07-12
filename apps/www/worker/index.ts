// The marketing site's Worker entry (webhook-www). With `assets.run_worker_first`, this runs ahead of
// the static assets: it serves the asset unchanged via the ASSETS binding, and — for a successful HTML
// page view only — writes ONE aggregate, cookieless data point to Workers Analytics Engine. All of the
// policy (what is / isn't recorded, bot filtering, bounds) lives in ../src/lib/analytics.ts and is unit
// tested there; this file is the ~1 effect-wiring adapter, deliberately trivial.
//
// Kept OUT of src/ so Next never bundles it; typechecked by the www tsconfig (DOM libs), so it uses only
// Web-standard globals (Request/Response/URL) plus the minimal binding interfaces below — no
// @cloudflare/workers-types dependency, which would clash with the Next DOM lib config.
import { handleAnalyticsRequest } from "../src/lib/analytics";

/** The one Analytics Engine method we use. Locally declared to avoid the workers-types lib. */
interface AnalyticsEngineDataset {
  writeDataPoint(event: { blobs?: string[]; doubles?: number[]; indexes?: string[] }): void;
}

interface Env {
  /** The static-assets binding (valid because this Worker has a `main`). */
  ASSETS: { fetch(request: Request): Promise<Response> };
  /** The cookieless page-view dataset (analytics_engine_datasets in wrangler.jsonc). */
  WWW_ANALYTICS: AnalyticsEngineDataset;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleAnalyticsRequest(request, {
      fetchAsset: (r) => env.ASSETS.fetch(r),
      writeDataPoint: (e) => env.WWW_ANALYTICS.writeDataPoint(e),
    });
  },
};
