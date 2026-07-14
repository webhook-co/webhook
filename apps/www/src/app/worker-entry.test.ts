import { describe, expect, it, vi } from "vitest";

import worker from "../../worker/index";
import { MTA_STS_HOST, MTA_STS_POLICY } from "../lib/mta-sts";

/**
 * Drives the Worker's EXPORTED `fetch` — the real production entry point.
 *
 * The pure cores (analytics.ts, mta-sts.ts) are unit-tested on their own, but nothing executed the
 * wiring. That mattered: the ordering in worker/index.ts is load-bearing. If the mta-sts check is ever
 * moved AFTER handleAnalyticsRequest, the policy host falls through to ASSETS and Cloudflare's
 * `not_found_handling: "404-page"` serves out/404.html — an HTML body at /.well-known/mta-sts.txt.
 * Senders reject a policy that isn't text/plain, so MTA-STS silently stops working while every unit
 * test still passes. A test of the pure module cannot see that; only one that drives `fetch` can.
 */

function bindings() {
  const fetchAsset = vi.fn(
    async () => new Response("<html>site</html>", { headers: { "content-type": "text/html" } }),
  );
  return {
    env: {
      ASSETS: { fetch: fetchAsset },
      WWW_ANALYTICS: { writeDataPoint: vi.fn() },
    },
    fetchAsset,
  };
}

describe("www Worker entry", () => {
  it("serves the MTA-STS policy on the policy host WITHOUT touching static assets", async () => {
    const { env, fetchAsset } = bindings();

    const res = await worker.fetch(
      new Request(`https://${MTA_STS_HOST}/.well-known/mta-sts.txt`),
      env as never,
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/^text\/plain/);
    expect(await res.text()).toBe(MTA_STS_POLICY);
    // If this ever fires, the ordering regressed and the policy would be served as out/404.html.
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("carries the site's security baseline on the policy host (it bypasses _headers)", async () => {
    const { env } = bindings();
    const res = await worker.fetch(
      new Request(`https://${MTA_STS_HOST}/.well-known/mta-sts.txt`),
      env as never,
    );

    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("strict-transport-security")).toMatch(/max-age=\d+/);
    expect(res.headers.get("x-frame-options")).toBe("DENY");
  });

  it("404s other paths on the policy host rather than serving the marketing site", async () => {
    const { env, fetchAsset } = bindings();
    const res = await worker.fetch(new Request(`https://${MTA_STS_HOST}/pricing`), env as never);

    expect(res.status).toBe(404);
    expect(fetchAsset).not.toHaveBeenCalled();
  });

  it("falls through to static assets for the marketing site, unchanged", async () => {
    const { env, fetchAsset } = bindings();
    const res = await worker.fetch(new Request("https://www.webhook.co/pricing"), env as never);

    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("<html>site</html>");
  });

  it("does not hijack /.well-known/mta-sts.txt on the www host", async () => {
    const { env, fetchAsset } = bindings();
    await worker.fetch(new Request("https://www.webhook.co/.well-known/mta-sts.txt"), env as never);

    expect(fetchAsset).toHaveBeenCalledOnce();
  });
});
