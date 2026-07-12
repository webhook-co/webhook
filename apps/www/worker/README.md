# webhook-www Worker — cookieless page analytics

The marketing site is a static export served by Workers Static Assets. This tiny Worker
(`worker/index.ts`) runs ahead of the assets (`assets.run_worker_first: true`), serves every asset
unchanged via the `ASSETS` binding, and writes **one aggregate data point per successful HTML page
view** to Workers Analytics Engine (dataset `webhook_www_analytics`, binding `WWW_ANALYTICS`).

All of the recording policy lives in `../src/lib/analytics.ts` and is unit-tested
(`../src/lib/analytics.test.ts`). This file just wires the two IO effects (fetch asset, write point).

## What is recorded (and what is not)

Per page view, one data point:

| field       | slot        | notes                                                        |
| ----------- | ----------- | ----------------------------------------------------------- |
| path        | `index1`, `blob1` | e.g. `/pricing`; the Analytics Engine index (≤96 bytes) |
| referrer    | `blob2`     | **host only** (`news.ycombinator.com`) — never path/query   |
| country     | `blob3`     | Cloudflare edge country code, e.g. `PT` (country-level)     |
| utm_source  | `blob4`     | from the link's query string                                |
| utm_medium  | `blob5`     |                                                             |
| utm_campaign| `blob6`     |                                                             |
| utm_content | `blob7`     |                                                             |
| utm_term    | `blob8`     |                                                             |
| status      | `double1`   | always 2xx (non-2xx and non-HTML are not logged)            |

**Never recorded:** IP address, cookies, any user/device identifier, the full referrer URL, or any
query parameter beyond the five UTM keys. Bots/crawlers/monitors are dropped by User-Agent. This is
why the site needs no cookie banner and the privacy policy needed no retraction — it's disclosed as
aggregate, cookieless measurement under GDPR Art. 13 on `/privacy`.

## Querying the data (Analytics Engine SQL API)

Analytics Engine has no dashboard UI; query it over the SQL API with a Cloudflare API token that has
**Account Analytics: Read**. `blobN`/`doubleN` are the field names; `_sample_interval` weights each
row for sampling (near-1 at this traffic, but always multiply by it for correct counts).

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/analytics_engine/sql" \
  -H "Authorization: Bearer $CF_ANALYTICS_TOKEN" \
  -d "SELECT blob1 AS path, SUM(_sample_interval) AS views
      FROM webhook_www_analytics
      WHERE timestamp > NOW() - INTERVAL '7' DAY
      GROUP BY path ORDER BY views DESC LIMIT 50"
```

Other useful queries (same endpoint, swap the SQL):

```sql
-- Top external referrers (exclude our own domain + direct/no-referrer)
SELECT blob2 AS referrer, SUM(_sample_interval) AS views
FROM webhook_www_analytics
WHERE timestamp > NOW() - INTERVAL '30' DAY AND blob2 != '' AND blob2 NOT LIKE '%webhook.co'
GROUP BY referrer ORDER BY views DESC LIMIT 25;

-- Views by country
SELECT blob3 AS country, SUM(_sample_interval) AS views
FROM webhook_www_analytics
WHERE timestamp > NOW() - INTERVAL '30' DAY AND blob3 != ''
GROUP BY country ORDER BY views DESC;

-- Campaign attribution (UTM)
SELECT blob4 AS source, blob5 AS medium, blob6 AS campaign, SUM(_sample_interval) AS views
FROM webhook_www_analytics
WHERE timestamp > NOW() - INTERVAL '90' DAY AND blob4 != ''
GROUP BY source, medium, campaign ORDER BY views DESC;
```

The dataset is auto-created on first write; nothing to provision beyond deploying the Worker.

## Accuracy caveats (it's a directional metric, not a ledger)

- **Client-side navigation undercounts.** After the first load, Next `<Link>` navigations are
  client-routed and never reach the Worker, so only the entry page of a session is counted. Treat
  numbers as _entry page views_, not total in-app views.
- **Prefetch may slightly inflate.** Next prefetches linked routes; a prefetch served as a 200
  `text/html` document would be counted. Verify against the real export if absolute precision matters.
- **HEAD requests** to an HTML page count (mostly absorbed by the bot filter); **304s** don't.

These don't affect page serving — they're reasons to read the data as trends (top pages, referrers,
campaigns), not exact visit totals.
