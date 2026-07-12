// @vitest-environment node
import { describe, expect, it } from "vitest";

import { buildDataPoint, handleAnalyticsRequest, type AnalyticsEvent } from "./analytics";

// The privacy + abuse surface of the server-side analytics collector, unit-tested. buildDataPoint is
// pure (Request signals in → an Analytics Engine data point, or null when the request must not be
// logged), so the exact set of things we record — and the things we deliberately DON'T (IPs, cookies,
// full referrers, arbitrary query strings, bots, non-page requests) — is pinned here, not left to a
// live worker. Mirrors apps/telemetry's collector conventions: known fields only, bounded lengths.

const PAGE = {
  url: "https://www.webhook.co/pricing",
  referrer: null,
  country: "PT",
  userAgent: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/120 Safari/537.36",
  contentType: "text/html; charset=utf-8",
  status: 200,
};

describe("buildDataPoint — what gets recorded", () => {
  it("records a 2xx HTML page view: path in the index + blobs, status in doubles", () => {
    const dp = buildDataPoint(PAGE);
    expect(dp).not.toBeNull();
    expect(dp!.indexes).toEqual(["/pricing"]);
    expect(dp!.blobs[0]).toBe("/pricing"); // path
    expect(dp!.doubles).toEqual([200]);
  });

  it("parses UTM attribution params from the query string into fixed blob slots", () => {
    const dp = buildDataPoint({
      ...PAGE,
      url: "https://www.webhook.co/?utm_source=twitter&utm_medium=social&utm_campaign=launch&utm_content=hero&utm_term=agents",
    });
    expect(dp).not.toBeNull();
    // path is just "/" — query is NOT stored as the path
    expect(dp!.indexes).toEqual(["/"]);
    expect(dp!.blobs).toEqual([
      "/", // path
      "", // referrer host (none)
      "PT", // country
      "twitter", // utm_source
      "social", // utm_medium
      "launch", // utm_campaign
      "hero", // utm_content
      "agents", // utm_term
    ]);
  });

  it("stores ONLY the referrer host — never its path or query (no PII from referrers)", () => {
    const dp = buildDataPoint({
      ...PAGE,
      referrer: "https://mail.google.com/mail/u/0/?token=SECRET&q=private",
    });
    expect(dp!.blobs[1]).toBe("mail.google.com");
    // the sensitive path/query never lands in any field
    expect(JSON.stringify(dp)).not.toContain("SECRET");
    expect(JSON.stringify(dp)).not.toContain("private");
  });

  it("does NOT record the query string beyond the whitelisted UTM keys", () => {
    const dp = buildDataPoint({
      ...PAGE,
      url: "https://www.webhook.co/pricing?email=alice@example.com&token=abc123",
    });
    expect(dp).not.toBeNull();
    expect(JSON.stringify(dp)).not.toContain("alice@example.com");
    expect(JSON.stringify(dp)).not.toContain("abc123");
  });
});

describe("buildDataPoint — what is dropped (null)", () => {
  it("drops non-HTML responses (static assets: JS/CSS/fonts/images)", () => {
    expect(
      buildDataPoint({
        ...PAGE,
        url: "https://www.webhook.co/_next/static/x.js",
        contentType: "application/javascript",
      }),
    ).toBeNull();
    expect(buildDataPoint({ ...PAGE, contentType: "image/svg+xml" })).toBeNull();
    expect(buildDataPoint({ ...PAGE, contentType: null })).toBeNull();
  });

  it("drops non-2xx responses (404 pages, redirects) so they don't count as page views", () => {
    expect(buildDataPoint({ ...PAGE, status: 404 })).toBeNull();
    expect(buildDataPoint({ ...PAGE, status: 301 })).toBeNull();
    expect(buildDataPoint({ ...PAGE, status: 500 })).toBeNull();
  });

  it("drops known bots and crawlers by user-agent (best-effort)", () => {
    for (const ua of [
      "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
      "facebookexternalhit/1.1",
      "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120 Safari/537.36",
      "curl/8.4.0",
      "python-requests/2.31.0",
      "Mozilla/5.0 (compatible; UptimeRobot/2.0; http://www.uptimerobot.com/)",
    ]) {
      expect(buildDataPoint({ ...PAGE, userAgent: ua })).toBeNull();
    }
  });

  it("drops requests with no user-agent (health checks / scripted probes)", () => {
    expect(buildDataPoint({ ...PAGE, userAgent: null })).toBeNull();
    expect(buildDataPoint({ ...PAGE, userAgent: "" })).toBeNull();
  });
});

describe("buildDataPoint — bounded + defensive (no arbitrary blobs)", () => {
  it("caps the path used as the Analytics Engine index at 96 bytes", () => {
    const longPath = "/" + "a".repeat(300);
    const dp = buildDataPoint({ ...PAGE, url: `https://www.webhook.co${longPath}` });
    expect(dp).not.toBeNull();
    expect(dp!.indexes[0].length).toBeLessThanOrEqual(96);
  });

  it("keeps the index within 96 BYTES even for a long non-ASCII path (percent-encoded by URL)", () => {
    // A non-ASCII path is percent-encoded by WHATWG URL (/😀 → /%F0%9F%98%80…), so the index is
    // always ASCII — but that encoding balloons the length, so the byte cap must still hold.
    const url = `https://www.webhook.co/${"😀".repeat(60)}`;
    const encodedPath = new URL(url).pathname; // what buildDataPoint sees
    const dp = buildDataPoint({ ...PAGE, url });
    expect(dp).not.toBeNull();
    expect(new TextEncoder().encode(dp!.indexes[0]).length).toBeLessThanOrEqual(96);
    // The index is a byte-bounded prefix of the real (encoded) path — never longer than the source.
    expect(encodedPath.startsWith(dp!.indexes[0])).toBe(true);
  });

  it("drops (does NOT truncate) over-length or control-char UTM values", () => {
    const dp = buildDataPoint({
      ...PAGE,
      url: `https://www.webhook.co/?utm_source=${"x".repeat(400)}&utm_medium=a%00b`,
    });
    expect(dp!.blobs[3]).toBe(""); // over-length utm_source → dropped to empty, not truncated
    expect(dp!.blobs[4]).toBe(""); // control char → dropped to empty
  });

  it("normalises country to an uppercase short code, else empty", () => {
    expect(buildDataPoint({ ...PAGE, country: "pt" })!.blobs[2]).toBe("PT");
    expect(buildDataPoint({ ...PAGE, country: "not-a-country!!" })!.blobs[2]).toBe("");
    expect(buildDataPoint({ ...PAGE, country: null })!.blobs[2]).toBe("");
  });
});

describe("handleAnalyticsRequest — the worker shell (IO injected)", () => {
  const htmlAsset = () =>
    new Response("<!doctype html><title>ok</title>", {
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  function makeReq(path: string, headers: Record<string, string> = {}): Request {
    return new Request(`https://www.webhook.co${path}`, {
      headers: { "user-agent": PAGE.userAgent, "cf-ipcountry": "PT", ...headers },
    });
  }

  it("passes the asset response through unchanged and logs the HTML page view once", async () => {
    const asset = htmlAsset();
    const points: AnalyticsEvent[] = [];
    const res = await handleAnalyticsRequest(makeReq("/pricing"), {
      fetchAsset: async () => asset,
      writeDataPoint: (e) => void points.push(e),
    });
    expect(res).toBe(asset); // exact pass-through — headers (CSP etc.) preserved
    expect(points).toHaveLength(1);
    expect(points[0].indexes).toEqual(["/pricing"]);
    expect(points[0].blobs[2]).toBe("PT"); // country from cf-ipcountry header
  });

  it("does NOT log when the asset is a static (non-HTML) file", async () => {
    const points: AnalyticsEvent[] = [];
    const res = await handleAnalyticsRequest(makeReq("/_next/static/x.js"), {
      fetchAsset: async () =>
        new Response("//js", {
          status: 200,
          headers: { "content-type": "application/javascript" },
        }),
      writeDataPoint: (e) => void points.push(e),
    });
    expect(res.status).toBe(200);
    expect(points).toHaveLength(0);
  });

  it("does NOT log a 404 HTML page (not_found_handling serves 404.html with a 404 status)", async () => {
    const points: AnalyticsEvent[] = [];
    const res = await handleAnalyticsRequest(makeReq("/does-not-exist"), {
      fetchAsset: async () =>
        new Response("<!doctype html><title>not found</title>", {
          status: 404,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
      writeDataPoint: (e) => void points.push(e),
    });
    expect(res.status).toBe(404);
    expect(points).toHaveLength(0);
  });

  it("reads the referrer from the Referer header, host-only", async () => {
    const points: AnalyticsEvent[] = [];
    await handleAnalyticsRequest(
      makeReq("/", { referer: "https://news.ycombinator.com/item?id=1" }),
      {
        fetchAsset: async () => htmlAsset(),
        writeDataPoint: (e) => void points.push(e),
      },
    );
    expect(points[0].blobs[1]).toBe("news.ycombinator.com");
  });

  it("never throws even if writeDataPoint would — analytics must not break page serving", async () => {
    const asset = htmlAsset();
    const res = await handleAnalyticsRequest(makeReq("/"), {
      fetchAsset: async () => asset,
      writeDataPoint: () => {
        throw new Error("analytics backend down");
      },
    });
    expect(res).toBe(asset); // the page is still served
  });
});
