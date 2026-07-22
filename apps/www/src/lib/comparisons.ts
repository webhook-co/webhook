// The `/vs/<slug>` comparison estate.
//
// ── Why competitor names are allowed in this file ────────────────────────────────────────────────
// This is `apps/www` MARKETING CONTENT, which the founder opened to competitor names on 2026-07-22.
// The line is CONTENT vs LOGIC, not public vs private: names may appear here, in the components that
// render this data, in the route manifest, the nav and the sitemap. They must never appear in the
// engine, CLI, SDKs, API, contracts, the provider registry, migrations, ADRs or docs. A competitor is
// something the marketing site talks about; it must never become something the product knows about.
//
// ── Why every page is shaped differently ─────────────────────────────────────────────────────────
// A comparison page has a more rigid rhetorical skeleton than a tutorial (positioning → concessions →
// differences → migration), so structural overlap is HIGHER by default and the templated-estate
// failure mode is closer, not further away. `comparisons.test.ts` therefore holds this estate to a
// threshold far below the shared guard's 0.8 reject line, because 0.8 would wave a template straight
// through — see that file for the reuse measurements the threshold is derived from. (The guard
// shingles on 5-grams, `SHINGLE_K` in `scripts/content-dup-guard.mjs`.)
//
// The mechanism that produces the distinctness is NOT prose variation. It is that each page has a
// different `sections` list, derived from what THAT comparison actually turns on:
//   • ngrok        — it is a gateway, not a queue. The whole page turns on what happens when you are down.
//   • webhook.site — it is a bin, not a system of record. The page turns on the clock and on who can read it.
//   • Hookdeck     — the closest competitor, and more mature than us. The page turns on how many
//                    numbers are in the bill, and concedes more than it claims.
//   • RequestBin   — the tool people remember does not exist any more. The page turns on its history.
// If two pages ever share a section list, they are one page with the noun swapped and should not ship.
//
// ── The accuracy bar ─────────────────────────────────────────────────────────────────────────────
// Every claim about another company was read off THEIR OWN pages on the date in `checked`, never from
// memory and never from a third-party summary. Claims about us are verified against shipped code in
// this repo. Where two of a competitor's own pages disagree, we say nothing: webhook.site's FAQ and
// its plan table state different free request caps (100 vs 50), so this estate cites neither and
// leads on the retention window, which three of their pages agree on.
//
// Facts the research turned up that would have made this estate WRONG, kept here so nobody
// reintroduces them: ngrok free URLs no longer rotate on restart (every account gets a permanent
// auto-assigned dev domain), ngrok free endpoints have no session timeout, and ngrok does verify
// webhook signatures. All three are the classic ngrok talking points and all three are now false.

import type { FaqItem } from "@/components/marketing/faq";

/** A primary source: their own page, ours, or a spec. Dated, because a claim decays. */
export interface ComparisonSource {
  /** Short id referenced by table rows. */
  readonly id: string;
  readonly label: string;
  readonly url: string;
  /** ISO date the URL was actually read. */
  readonly checked: string;
}

/** One row of the at-a-glance table. Every row must be checkable by a stranger. */
export interface ComparisonRow {
  readonly label: string;
  readonly them: string;
  readonly us: string;
  /** Which `sources` entry backs the `them` cell. */
  readonly sourceId: string;
}

export interface ComparisonSection {
  /** Unique within the page — it becomes a DOM `id`, and `check-anchors.mjs` makes ids a contract. */
  readonly id: string;
  readonly heading: string;
  readonly body: string;
}

/**
 * A migration step. Structurally identical to a section, but its `id` is a React key ONLY — it never
 * reaches the DOM, so it carries none of the anchor-contract weight `ComparisonSection.id` does.
 */
export interface MigrationStep {
  readonly id: string;
  readonly heading: string;
  readonly body: string;
}

export interface Comparison {
  /** URL segment: `/vs/<slug>`. */
  readonly slug: string;
  /** Their display name, in THEIR casing. Plain text only — never their logo or brand colours. */
  readonly name: string;
  /** `<title>`; the root template appends the brand, so it must not repeat it. */
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly lede: string;
  /** ISO date the whole page's claims were last re-read. Rendered visibly, above the fold. */
  readonly verifiedOn: string;
  /**
   * Why someone is on this page at all — the specific frustration that sent them. Must be unusable on
   * any sibling page; if it would read true of another competitor, the page has no reason to exist.
   */
  readonly whyLeave: string;
  /** The one argument this page is built on. */
  readonly distinctive: string;
  /** The dimension H2s, derived per competitor. Never a shared list. */
  readonly sections: readonly ComparisonSection[];
  /** Where they are the better choice, named as a mechanism and a consequence. The credibility wall. */
  readonly chooseThem: { readonly heading: string; readonly body: string };
  readonly chooseUs: { readonly heading: string; readonly body: string };
  readonly table: readonly ComparisonRow[];
  readonly migration: readonly MigrationStep[];
  readonly faq: readonly FaqItem[];
  readonly sources: readonly ComparisonSource[];
}

/**
 * Marketing claims this estate may never publish, about anyone.
 *
 * DELIBERATELY PARTIAL. The certification, identity, SLA and guarantee claims are NOT listed here —
 * they live in `scripts/no-unverified-claims.mjs`'s `CLAIM_RULES`, which is the real gate, runs over
 * this whole directory in `pnpm lint`, and which the tests import directly rather than paraphrase.
 * Restating those terms here would be worse than duplication: the guard scans this file, so writing
 * "SOC 2" or "SAML" into it — even inside a regex that exists to forbid them — fails the build. It
 * did, which is how this comment came to be written.
 *
 * What remains are the estate-specific ones the guard has no opinion about, all of them safe to name.
 */
export const FORBIDDEN_CLAIMS = /trusted by|free, permanent|zero-knowledge|\bunlimited\b/i;

const CHECKED = "2026-07-22";

export const COMPARISONS: readonly Comparison[] = [
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    slug: "ngrok",
    name: "ngrok",
    title: "ngrok alternative for webhooks",
    description:
      "ngrok routes webhooks to your machine in real time. It does not queue them. An honest comparison of what each tool is for, with sources, checked July 2026.",
    h1: "webhook.co vs ngrok",
    lede: "ngrok is a gateway. We are a queue with an inspector attached. That one sentence decides almost every case, and most of the internet's advice about ngrok is several years out of date.",
    verifiedOn: CHECKED,
    whyLeave:
      "If you are here, it is probably not because ngrok is bad at its job. The failure that sends people looking is the one where a provider retries a webhook at 03:00, the laptop is shut, and the event is simply gone — there is no queue behind the tunnel to have caught it. There is a quieter version too: going back for the payload of a request from last Tuesday and finding that the free plan keeps a day of traffic, and only metadata unless somebody had already turned on full capture.",
    distinctive:
      "The question that separates these two tools is not speed, price, or URL stability. It is what happens to an event when the thing meant to receive it is not there. ngrok answers that question honestly and in its own error catalogue: when the agent serving an endpoint is not running, the request fails with ERR_NGROK_3200 and the provider sees a failed delivery. There is no buffer to drain when you come back. That is not an oversight — a gateway's job is to route what is happening now, and ngrok's entire traffic-policy action catalogue is built for inspection, authentication and transformation at the edge, with nothing in it that stores an event for later. We do the other job: accept the request, store it, and let you replay it into a handler you are still writing, days later.",
    sections: [
      {
        id: "what-ngrok-is-now",
        heading: "Three things about ngrok that used to be true",
        body: "Most comparison pages you will find about ngrok are repeating a version of it that no longer exists, so it is worth clearing this up before anything else — including the parts that make us look worse. Your free URL does not rotate any more: every account, free included, gets an automatically assigned dev domain that ngrok's own documentation says cannot be changed. Free endpoints do not time out; ngrok's free-plan limits page says so in bold, and points out you can run one as a background service indefinitely. And ngrok does verify webhook signatures — a verify-webhook traffic-policy action with a provider list of 69 entries at the time of writing, timestamp tolerance for replay protection, and a 403 on failure. If you picked us because you read that ngrok gives you a URL that changes every restart, you picked us for a reason that stopped being true.",
      },
      {
        id: "when-you-are-offline",
        heading: "What each tool does when your service is down",
        body: "Point a provider at an ngrok endpoint and stop the agent. The next delivery gets an endpoint-offline error, the provider marks it failed, and whether you ever see that event again depends entirely on that provider's own retry policy — some retry for days, some retry three times, some never. ngrok's documented remedies are to start the agent, pin a URL, enable endpoint pooling or check the dashboard — recover the connection, rather than recover the traffic that arrived without one. Point a provider at us and stop your handler. The request is still accepted and stored, and you replay it when you are ready. Our outbound side retries eight times over roughly twenty-eight hours with jitter before dead-lettering, so a destination that is down for an afternoon does not lose anything.",
      },
      {
        id: "the-inspector",
        heading: "Inspection, retention, and the 10 KB line",
        body: "Both tools let you look at a request and send it again, and the differences are in the defaults. ngrok's cloud inspector keeps traffic for 24 hours on Free and 72 hours on its paid self-serve plans, and pay-as-you-go customers can buy an add-on extending that to 90 days — which matches our longest published window, so the ceiling is a tie rather than the gap the free tiers suggest. By default it stores only metadata about each request — headers and bodies require turning on Full Capture for the whole account, which their own docs warn also exposes that data to everyone on your team. Once on, capture truncates at 10 KB, and a truncated request cannot be replayed at all. That last detail matters more than it sounds: a Shopify order payload or a fat Stripe invoice can cross 10 KB without trying. We store the whole body by default and keep it for the retention window on your plan, because inspecting the payload is the product rather than a mode you switch on. Our limit is a different shape and worth stating plainly: we accept bodies up to 1 MiB and reject anything larger with a 413, so where ngrok would truncate a very large payload and still deliver it, we refuse it outright. Above 1 MiB their behaviour is better than ours.",
      },
      {
        id: "verification-coverage",
        heading: "Signature verification, and how far the lists go",
        body: "This is a real comparison rather than a walkover. ngrok verifies at its edge, which is genuinely better placement than verifying in your own process — bad signatures never reach your compute. Their supported-provider table listed 69 entries when we counted it on the date below. Our registry covers 141 providers and is Apache-2.0, so you can read exactly how each one is verified rather than trusting that it is. The gap is the long tail: PayPal, Adyen, Salesforce, Discord, Vercel and Notion were all absent from ngrok's list on the date we checked. If your provider is on both lists, this row is a tie and you should decide on something else.",
      },
    ],
    chooseThem: {
      heading: "What ngrok does better",
      body: "Getting traffic into a network that blocks inbound connections. An outbound-only agent inside your firewall, your Kubernetes cluster or a customer's VPC is a structural advantage that a hosted receiver cannot replicate, and ngrok markets that pattern deliberately. It is also not only a webhook tool: TCP, TLS and SSH ingress, an API gateway, OAuth and mutual-TLS enforcement, a web application firewall and rate limiting all sit in the same traffic policy, so if you already need a gateway then verification comes along free. It runs almost anywhere — five agent SDKs and builds down to unusual architectures — and it has the enterprise paperwork, the procurement process and the decade of production use that we plainly do not. If your problem is reaching a machine rather than keeping an event, ngrok is the right tool and we are not.",
    },
    chooseUs: {
      heading: "Where we fit instead",
      body: "When the event has to survive you: a handler you are still writing, a laptop that closes, a deploy that fails. When you want the payload itself kept and searchable rather than a metadata trace of it. When you want the same capability from a CLI, a REST API, a dashboard and an MCP server without one of them being a second-class citizen. And when you would rather read the verification code than be told it works — the whole engine is Apache-2.0.",
    },
    table: [
      {
        label: "Holds an event while you are offline",
        them: "No — the request fails with an endpoint-offline error",
        us: "Yes — accepted, stored, replayable",
        sourceId: "ngrok-offline",
      },
      {
        label: "Request bodies stored by default",
        them: "No — metadata only until Full Capture is enabled",
        us: "Yes",
        sourceId: "ngrok-inspect",
      },
      {
        label: "Capture size limit",
        them: "10 KB stored, and a truncated request cannot be replayed",
        us: "1 MiB, and a larger request is rejected with a 413",
        sourceId: "ngrok-inspect",
      },
      {
        label: "Inspection retention",
        them: "24 hours free, 72 hours paid; up to 90 days purchasable on pay-as-you-go",
        us: "7 days Free, 30 Pro, 90 Scale",
        sourceId: "ngrok-inspect",
      },
      {
        label: "Provider signature verification",
        them: "69 providers listed; docs say 70+",
        us: "141 providers",
        sourceId: "ngrok-verify",
      },
      {
        label: "Free plan request allowance",
        them: "20,000 HTTP requests/month, 500 webhook verifications/month",
        us: "5,000 captured events, once, then capture pauses",
        sourceId: "ngrok-limits",
      },
      {
        label: "Stable URL on the free plan",
        them: "Yes — an assigned dev domain that cannot be changed",
        us: "Yes — a permanent ingest URL",
        sourceId: "ngrok-domains",
      },
      {
        label: "Licence of the receiving path",
        them: "Agent and cloud service source not published; SDKs are open source",
        us: "Apache-2.0, engine included",
        sourceId: "ngrok-sdks",
      },
      {
        label: "Outbound delivery with retries",
        them: "Not offered",
        us: "8 attempts over ~28 hours, then dead-letter",
        sourceId: "ngrok-actions",
      },
    ],
    migration: [
      {
        id: "run-both",
        heading: "Run both for a day",
        body: "You do not have to cut over to find out. Most providers let you register a second endpoint, so add an ingest URL alongside your ngrok endpoint and leave them both running. You will be comparing the same real traffic in two inspectors, which is the only comparison that settles anything, and you can drop whichever one you like less at no cost.",
      },
      {
        id: "swap-the-command",
        heading: "Swap the command, keep the loop",
        body: "The local development loop is the same shape. Where you ran ngrok http 3000 and copied the forwarding URL, you run wbhk listen --forward localhost:3000 against an ingest URL that already exists and does not change. The difference you will notice first is that closing the terminal no longer loses anything: events keep arriving and are waiting when you start listening again.",
      },
      {
        id: "what-does-not-move",
        heading: "What does not come with you",
        body: "Traffic-policy rules have no equivalent here, and if you were using ngrok for OAuth, mutual TLS, IP restrictions or a web application firewall in front of your app, we do none of that — keep ngrok for it. Anything already in ngrok's inspector stays there; there is no export we can read.",
      },
    ],
    faq: [
      {
        question: "Does ngrok still give you a random URL that changes on restart?",
        answer:
          "No. Every ngrok account, including the free one, gets an automatically assigned dev domain, and ngrok's documentation says its URL cannot be changed. What a paid plan buys is the ability to choose the name, use wildcards, or bring your own domain. Comparison pages claiming otherwise are out of date.",
      },
      {
        question: "Can ngrok verify a Stripe or GitHub webhook signature?",
        answer:
          "Yes. ngrok has a verify-webhook traffic-policy action that validates signatures at its edge, with timestamp tolerance for replay protection, and returns 403 when verification fails. Their supported-provider table listed 69 entries when we counted its rows on 22 July 2026.",
      },
      {
        question: "What happens to a webhook if ngrok is running but my app is not?",
        answer:
          "ngrok returns an error to the provider and the delivery is marked failed. Nothing is buffered for you to collect later. Whether you get another chance depends on the sending provider's own retry schedule, which varies from days of retries to none at all.",
      },
      {
        question: "Is the ngrok free plan enough for webhook development?",
        answer:
          "For occasional debugging, comfortably. Its published free-plan limits include 20,000 HTTP requests and 500 webhook verifications a month, one user, 1 GB of data transfer and 10,000 logged events. Traffic retention on that plan is 24 hours, which is documented separately on their traffic-inspection page.",
      },
    ],
    sources: [
      {
        id: "ngrok-offline",
        label: "ngrok error reference — ERR_NGROK_3200",
        url: "https://ngrok.com/docs/errors/err_ngrok_3200",
        checked: CHECKED,
      },
      {
        id: "ngrok-inspect",
        label: "ngrok docs — traffic inspection",
        url: "https://ngrok.com/docs/obs/traffic-inspection",
        checked: CHECKED,
      },
      {
        id: "ngrok-verify",
        label: "ngrok docs — verify-webhook traffic policy action",
        url: "https://ngrok.com/docs/traffic-policy/actions/verify-webhook",
        checked: CHECKED,
      },
      {
        id: "ngrok-limits",
        label: "ngrok docs — free plan limits",
        url: "https://ngrok.com/docs/pricing-limits/free-plan-limits",
        checked: CHECKED,
      },
      {
        id: "ngrok-domains",
        label: "ngrok docs — domains",
        url: "https://ngrok.com/docs/gateway/domains",
        checked: CHECKED,
      },
      {
        id: "ngrok-sdks",
        label: "ngrok docs — agent SDKs",
        url: "https://ngrok.com/docs/agent-sdks",
        checked: CHECKED,
      },
      {
        id: "ngrok-actions",
        label: "ngrok docs — traffic policy actions",
        url: "https://ngrok.com/docs/traffic-policy/actions",
        checked: CHECKED,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    slug: "webhook-site",
    name: "webhook.site",
    title: "webhook.site alternative",
    description:
      "webhook.site is the fastest way to see a request. Free captures last seven days and anyone with the link can read them. Checked July 2026.",
    h1: "webhook.co vs webhook.site",
    lede: "webhook.site gives you a URL before you have finished deciding you need one. That is a genuinely excellent property, and it is bought by treating captures as disposable — which is fine right up until the moment they are not.",
    verifiedOn: CHECKED,
    whyLeave:
      "The version of this that stings is a Monday. Something broke over the weekend, you go back to the URL you were debugging with, and the free tier has already deleted it — the data and the URL both, on a seven-day clock that runs whether or not you are watching. The other one is a security review, where someone notices that a free capture has no login in front of it, and that anything a provider sent — including whatever was in those payloads — has been readable by anyone holding the URL's id.",
    distinctive:
      "These two tools disagree about what a captured request is. webhook.site treats it as something you are looking at right now — a bin, brilliantly executed, with an automation engine bolted on that is genuinely more capable than ours. We treat it as a record: something with an owner, a retention window, an audit trail, and an expectation that you will come back to it. Neither view is wrong, and the free tiers make the difference concrete rather than philosophical. Theirs deletes the URL and its data after seven days and puts no login in front of it. Ours is private by default, keeps captures for seven days on the free tier and longer on paid plans, and never hands the endpoint to whoever guesses the id.",
    sections: [
      {
        id: "the-clock",
        heading: "The seven-day clock, and what a paid plan actually changes",
        body: "On the free tier a URL and everything sent to it are removed after seven days. That number is stated on webhook.site's own FAQ, repeated in their plan comparison table, and repeated again in their own blog, so it is about as well established as a competitor fact gets. Paying changes the shape of the problem rather than removing it: URLs on a paid account stop expiring, but data is still purged at a maximum of 365 days, and a Pro URL keeps only its most recent 10,000 requests with older ones rotated out. If you are chasing a bug that reproduces once a fortnight, the free clock is the thing that will beat you.",
      },
      {
        id: "who-can-read-it",
        heading: "Who can read your captures",
        body: "webhook.site is unusually straight about this in its own documentation: the free version operates without a login, so data is accessible to anyone who knows the id of the URL. For pasting a test request around, that is a feature — it is why sharing a debugging session with a colleague is a copy and a paste. It stops being a feature the moment a provider sends something real down that URL, because provider webhooks routinely carry customer email addresses, order contents and payment metadata. Paid URLs are login-protected by default. Ours are private by default at every tier, including free, and re-displaying an ingest URL is a separate write-scoped action that lands in an append-only audit log.",
      },
      {
        id: "verification",
        heading: "Signature verification: written by you, or shipped with the tool",
        body: "webhook.site can verify a signature, and we should be precise about how. Their documented path is a WebhookScript custom action calling hmac() with an algorithm and a secret, compared against a header you name yourself, returning 401 when it does not match. That is a real capability and a flexible one — but you are writing the verification, per URL, and custom actions are not available on the free tier at all. We ship verification for 141 providers as code you can read, and you can check a captured signature by hand in the browser without an account at all.",
      },
      {
        id: "automation",
        heading: "Where they are simply deeper than us",
        body: "It would be dishonest to write this page without saying that webhook.site's automation layer is the more capable product. Their action catalogue runs to dozens of types — HTTP requests, SMTP and SSH, FTP upload and download, database queries, S3 and CloudFront, Google Sheets, Excel, Dropbox, RabbitMQ, PDF generation and image resizing, plus JavaScript and their own WebhookScript language, with conditions, variables and rate limiting. You can build a working integration in their UI without deploying anything. We have nothing like it and are not building it: our answer to what happens next is that the event goes to your code, or to your agent over MCP.",
      },
    ],
    chooseThem: {
      heading: "What webhook.site does better",
      body: "Speed to a URL, and it is not close — the URL exists the moment the page loads, with no account, no install and no configuration. The automation layer described above is a genuinely deep no-code product that will save you writing a service you did not want to write. You also get an email address and a DNS name alongside the HTTP URL off the same token, which is unusually complete and very handy when you are testing something that might arrive by any of the three. And the self-hosted version is MIT-licensed with a Docker or Helm deploy, if you want the inspector on your own infrastructure. For throwaway debugging, sharing a request with a colleague, or mocking a response, reaching for it first is the correct instinct.",
    },
    chooseUs: {
      heading: "Where we fit instead",
      body: "When a capture needs to still exist next month, belong to someone, and be private without paying for privacy. When you want the request forwarded to a port on your machine and replayed as often as you like while you fix the handler. And when the same events need to reach your code and your agents through one contract rather than through a UI.",
    },
    table: [
      {
        label: "Free tier retention",
        them: "URL and data removed after 7 days",
        us: "7 days, and the ingest URL does not expire",
        sourceId: "whs-faq",
      },
      {
        label: "Free captures private by default",
        them: "No — no login; readable by anyone with the URL id",
        us: "Yes, at every tier",
        sourceId: "whs-faq",
      },
      {
        label: "Longest retention on a paid plan",
        them: "365 days maximum, and the latest 10,000 requests on Pro (100,000 on Enterprise)",
        us: "90 days on Scale; longer is negotiated",
        sourceId: "whs-plans",
      },
      {
        label: "Built-in per-provider signature verification",
        them: "No — hand-written in WebhookScript, and paid-only",
        us: "141 providers, Apache-2.0",
        sourceId: "whs-script",
      },
      {
        label: "Entry paid plan",
        them: "$9/month, or $90/year",
        us: "€19/month",
        sourceId: "whs-plans",
      },
      {
        label: "Self-hostable inspector",
        them: "Yes — MIT, without the custom-actions layer",
        us: "Yes — Apache-2.0",
        sourceId: "whs-oss",
      },
      {
        label: "No-code automation on captured requests",
        them: "Yes — dozens of action types plus a scripting language",
        us: "No",
        sourceId: "whs-actions",
      },
    ],
    migration: [
      {
        id: "keep-the-bin",
        heading: "Keep using it for what it is good at",
        body: "This is not a migration that has to be total, and we would not pretend otherwise. Plenty of people should keep a webhook.site tab open for throwaway inspection and move only the endpoints that matter — the ones a provider is configured against, the ones a colleague might need to look at in a month.",
      },
      {
        id: "map-the-concepts",
        heading: "What maps onto what",
        body: "A webhook.site URL becomes an endpoint with a permanent ingest URL. Their request list becomes your events list, with the same read-it-and-replay-it loop. A custom action that forwarded a request to your server becomes a destination with retries and a dead-letter queue behind it. A custom action that did anything cleverer than forwarding does not map, and that is the honest boundary of this comparison.",
      },
      {
        id: "export-first",
        heading: "Take anything you still need first",
        body: "There is no importer, and the seven-day clock is unforgiving, so anything you want to keep should come out before you stop looking. CSV export is a paid feature on their side; on a free URL, the practical answer is to copy what matters out by hand while it is still there.",
      },
    ],
    faq: [
      {
        question: "How long does webhook.site keep free requests?",
        answer:
          "Seven days, after which the URL and its data are both removed. That figure appears on webhook.site's FAQ, in their plan comparison table and in their own blog, so it is unambiguous. On a paid account URLs stop expiring, but data is still purged at a maximum of 365 days.",
      },
      {
        question: "Is data sent to a free webhook.site URL private?",
        answer:
          "No. Their documentation states that the free version operates without a login, so the data is accessible to anyone who knows the id of the URL. URLs on a paid subscription are login-protected by default. Treat a free URL as public and never point live provider traffic at one.",
      },
      {
        question: "Can webhook.site check a provider's signature for me?",
        answer:
          "Not as a built-in per-provider feature. It gives you an hmac() function inside a WebhookScript custom action, so you write the verification yourself against a header you specify. Custom actions are not included on the free tier.",
      },
      {
        question: "Is webhook.site open source?",
        answer:
          "The inspector is, under the MIT licence, and can be self-hosted with Docker or Helm. Their documentation is explicit that the self-hosted build does not include the Pro custom-actions layer, so the automation features are not part of what you can run yourself.",
      },
    ],
    sources: [
      {
        id: "whs-faq",
        label: "webhook.site documentation — FAQ",
        url: "https://docs.webhook.site/",
        checked: CHECKED,
      },
      {
        id: "whs-plans",
        label: "webhook.site documentation — plans and pricing",
        url: "https://docs.webhook.site/pro.html",
        checked: CHECKED,
      },
      {
        id: "whs-script",
        label: "webhook.site documentation — WebhookScript examples",
        url: "https://docs.webhook.site/webhookscript/examples.html",
        checked: CHECKED,
      },
      {
        id: "whs-actions",
        label: "webhook.site documentation — custom action types",
        url: "https://docs.webhook.site/custom-actions/action-types.html",
        checked: CHECKED,
      },
      {
        id: "whs-oss",
        label: "webhook.site documentation — open source",
        url: "https://docs.webhook.site/open-source.html",
        checked: CHECKED,
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    slug: "hookdeck",
    name: "Hookdeck",
    title: "Hookdeck alternative",
    description:
      "Hookdeck is the closest thing to us that exists, and it is further along. Where it wins, where the bill gets complicated, and who should pick which. July 2026.",
    h1: "webhook.co vs Hookdeck",
    lede: "This is the comparison where we concede the most, because Hookdeck is doing the same job, has been doing it for years, and does several parts of it better than we do today.",
    verifiedOn: CHECKED,
    whyLeave:
      "When people go looking, it tends to be the invoice — and specifically its shape rather than its size. Hookdeck's Event Gateway meters delivered events, but it also meters throughput as a separate purchase — the default ceiling is five events per second per destination — and it meters discarded requests, which are the requests your own filters threw away. Both paid tiers are advertised as starting at a price rather than being one. The second reason is quieter and only affects some teams: the read-only role and the directory-sync features start at the four-hundred-and-ninety-nine-dollar tier.",
    distinctive:
      "The interesting difference here is not a feature, it is how many numbers you need to predict a bill. Hookdeck's Event Gateway prices on a plan fee, a tiered rate for delivered events, a separately purchased throughput ceiling in events per second per destination, a metered charge for discarded requests beyond an included allowance, a retention window fixed by tier, and a static-IP add-on. Every one of those is a defensible engineering decision and several are genuinely fairer than a flat rate at scale. But six dials is six things to model before you know what next month costs. We meter one thing — captured events — and when a free organization runs out, capture pauses rather than billing you. That is a deliberate constraint on us as much as a feature for you: it means we cannot invent a second meter later without breaking our own rule.",
    sections: [
      {
        id: "where-they-are-ahead",
        heading: "Where Hookdeck is straightforwardly ahead",
        body: "We are pre-launch and they are not, and most of this list follows from that. They publish a component-level status page and contractual uptime and latency commitments on their upper tiers. We publish a status page too, but make no contractual uptime commitment — our own terms disclaim one. They have a first-party Terraform provider, so a platform team can manage connections as code. They have the compliance paperwork that gets a vendor through procurement, and a trust centre to serve it from; we hold no certifications and say so on our privacy page. Their issue model is more developed than ours — delivery, transformation and backpressure issues as first-class objects, with a configurable queue-time threshold and two-way sync into incident tooling. They support arbitrary JavaScript transformations on every tier including free. And their outbound product is Apache-2.0 and genuinely self-hostable, delivering to queues and brokers rather than only to HTTP.",
      },
      {
        id: "the-bill",
        heading: "How many numbers are in the bill",
        body: "Worth walking through concretely, because the throughput dial is the one that surprises people. A Hookdeck project includes five events per second of delivery throughput per destination; above that, events are queued rather than rejected, which is the right behaviour, but their latency commitment explicitly does not apply to delivery above your purchased throughput. So a burst-heavy source does not cost you events, it costs you either latency or a throughput purchase. Separately, requests your filters discard count against an allowance, and past it they are billed per million — you are paying a little for traffic you configured the system to throw away. Our meter is the captured request, disclosed at the point you create an endpoint, with a soft cap that pauses rather than surprises.",
      },
      {
        id: "verification-parity",
        heading: "Provider coverage is roughly a tie",
        body: "We would rather say this than let a table imply otherwise. Their documentation lists 146 source types, of which 141 are named third-party platforms, and their public OpenAPI specification defines provider-specific verification configurations for 135 of them. Our registry covers 141 providers. Those numbers are close enough that provider coverage should not decide anything between us, and anyone telling you otherwise is counting selectively. The real difference is that ours is Apache-2.0 and readable, and that we ship an in-browser verifier you can paste a captured request into without an account.",
      },
      {
        id: "agents",
        heading: "What an agent is allowed to do",
        body: "Both of us have shipped MCP servers, and they are scoped very differently. Hookdeck's runs locally over stdio through their CLI, and the MCP server itself is read-only by design: their documentation is explicit that it exposes no tools to create or update sources, destinations, connections or transformations, and that retrying an event is not available through it. That is not the whole picture, and their own page says so — writes are routed through their published Agent Skills instead, so a Hookdeck agent can create and change things, just not through the MCP surface. Ours is a remote server with OAuth where the writes live in the MCP itself, and that includes destructive ones: an agent holding our token can delete an endpoint, delete captured events and rotate an ingest URL. We withhold delivery destinations and payload bodies deliberately, because an agent that can redirect where your events go is a confused-deputy problem — but we should be straight that our surface is the more powerful and therefore the more dangerous of the two, and that theirs is a defensible way to draw the line.",
      },
    ],
    chooseThem: {
      heading: "When to choose Hookdeck",
      body: "If you are putting this in front of production traffic this quarter, choose Hookdeck. They have the operational maturity, the incident tooling, the contractual commitments and the compliance evidence, and we have a pre-launch product and a promise. Choose them if you need to fan out to queues and brokers rather than HTTP endpoints, if you need infrastructure-as-code, if you need transformations you can write in JavaScript, if you need to satisfy a security questionnaire, or if you are at a volume where their per-event rate card falls well below our flat tiers. Choose them if your organisation needs a read-only role. That is a lot of reasons, and they are all real.",
    },
    chooseUs: {
      heading: "When to choose us",
      body: "If a predictable single-meter bill matters more than a rate card that optimises at scale. If you want the receiving path itself to be open source rather than the outbound half. If you want your agents to act on events over a remote MCP server rather than only read them. And if replaying a captured event straight to a port on your laptop is part of your daily loop rather than an occasional debugging move.",
    },
    table: [
      {
        label: "Billing dimensions on the inbound product",
        them: "Plan fee, events, throughput, discarded requests, retention tier, static-IP add-on",
        us: "One: captured events",
        sourceId: "hd-pricing",
      },
      {
        label: "Default delivery throughput",
        them: "5 events/second per destination; more is a purchase",
        us: "Not metered separately",
        sourceId: "hd-pricing",
      },
      {
        label: "Charge for requests your filters discard",
        them: "Metered past an included allowance",
        us: "None",
        sourceId: "hd-pricing",
      },
      {
        label: "Free tier",
        them: "10,000 events, 3-day retention, dashboard locks past the cap",
        us: "5,000 events once, 7-day retention, capture pauses",
        sourceId: "hd-pricing",
      },
      {
        label: "Provider signature verification",
        them: "135 provider-specific configs in their OpenAPI spec",
        us: "141 providers",
        sourceId: "hd-openapi",
      },
      {
        label: "Inbound path source published",
        them: "No — their Apache-2.0 project is the outbound product",
        us: "Yes — Apache-2.0, engine included",
        sourceId: "hd-outpost",
      },
      {
        label: "MCP server scope",
        them: "Local stdio; the MCP itself is read-only, writes go through their Agent Skills",
        us: "Remote with OAuth; the MCP itself writes, including destructive tools",
        sourceId: "hd-mcp",
      },
      {
        label: "Maintained SDKs for the inbound product",
        them: "TypeScript and Go SDK repositories are archived",
        us: "TypeScript, Python and Go, published",
        sourceId: "hd-sdk-ts",
      },
      {
        // We publish a status page too now (status.webhook.co), so that is no longer a difference and
        // has left this table. What remains genuinely theirs is the CONTRACTUAL commitment — our terms
        // disclaim any uptime guarantee — so the row is narrowed to that.
        label: "Contractual uptime and latency commitments",
        them: "Yes",
        us: "No",
        // A contractual SLA is a pricing-tier fact (their upper tiers), so it is cited to the pricing
        // page — not the status page, which evidences uptime history rather than a commitment.
        sourceId: "hd-pricing",
      },
      {
        label: "Payload transformations and filtering",
        them: "JavaScript transformations and filters, on every tier",
        us: "Neither",
        sourceId: "hd-sources",
      },
      {
        label: "Maximum inbound payload",
        them: "10 MiB",
        us: "1 MiB",
        sourceId: "hd-sources",
      },
      {
        label: "Delivery to queues and brokers",
        them: "Yes, through their outbound product",
        us: "HTTP destinations only",
        sourceId: "hd-outpost",
      },
    ],
    migration: [
      {
        id: "shape-matches",
        heading: "The nouns line up",
        body: "This is the easiest mapping in the estate because the models genuinely resemble each other. A Hookdeck source becomes an endpoint, a destination stays a destination, and a connection between them becomes a subscription. Their requests are our captured events and their events are our deliveries — worth reading twice, because the two products use the word event for different halves of the journey.",
      },
      {
        id: "what-has-no-equivalent",
        heading: "What has no equivalent here",
        body: "Transformations. If you are rewriting payloads in JavaScript inside Hookdeck, we have nothing to move that to, and you would be moving that logic back into your own service. Filters are the same story. If those are load-bearing for you, this migration is not worth starting, and we would rather you found that out in this paragraph than three days in.",
      },
      {
        id: "parallel",
        heading: "Fan out to both, then decide",
        body: "Register a second endpoint at your provider and let the same traffic land in both systems for a week. Compare the delivery logs rather than the marketing pages, including on a day something fails. It is the only way to test the claim on this page that matters, which is that the bill stays predictable.",
      },
    ],
    faq: [
      {
        question: "Is Hookdeck more mature than webhook.co?",
        answer:
          "Yes. They have been running this in production for years, publish contractual availability commitments, hold compliance certifications, and ship a Terraform provider. We are pre-launch. If maturity is the deciding factor for you, it should point at them.",
      },
      {
        question: "What does Hookdeck charge for beyond the events it delivers?",
        answer:
          "Their published Event Gateway pricing meters delivered events, a throughput ceiling in events per second per destination, and discarded requests past an included allowance, alongside the plan fee, a retention window set by tier, and a static-IP add-on. Both paid tiers are listed as starting at a price.",
      },
      {
        question: "Which one verifies more provider signatures?",
        answer:
          "It is effectively a tie. Hookdeck documents 146 source types including 141 named platforms, with 135 provider-specific verification configurations in their public OpenAPI specification. Our registry covers 141 providers. Coverage should not be the deciding factor between these two products.",
      },
      {
        question: "Can I self-host either product?",
        answer:
          "Hookdeck's outbound delivery product is Apache-2.0 and designed to be self-hosted; their inbound Event Gateway is not offered as a self-hosted product. Our engine, CLI, MCP server, SDKs and verification registry are all Apache-2.0.",
      },
    ],
    sources: [
      {
        id: "hd-pricing",
        label: "Hookdeck pricing",
        url: "https://hookdeck.com/pricing",
        checked: CHECKED,
      },
      {
        id: "hd-openapi",
        label: "Hookdeck public OpenAPI specification (verification configs)",
        url: "https://api.hookdeck.com/2025-07-01/openapi",
        checked: CHECKED,
      },
      {
        id: "hd-sources",
        label: "Hookdeck docs — source types",
        url: "https://hookdeck.com/docs/sources",
        checked: CHECKED,
      },
      {
        id: "hd-outpost",
        label: "Hookdeck Outpost pricing and licence",
        url: "https://hookdeck.com/outpost/pricing",
        checked: CHECKED,
      },
      {
        id: "hd-mcp",
        label: "Hookdeck docs — MCP server",
        url: "https://hookdeck.com/docs/mcp",
        checked: CHECKED,
      },
      {
        id: "hd-sdk-ts",
        label: "Hookdeck TypeScript SDK repository",
        url: "https://github.com/hookdeck/hookdeck-typescript-sdk",
        checked: CHECKED,
      },
    ],
  },
  // ──────────────────────────────────────────────────────────────────────────────────────────────
  {
    slug: "requestbin",
    name: "RequestBin",
    title: "RequestBin alternative",
    description:
      "The RequestBin most people remember needed no signup. That one does not exist any more. What replaced it, and what to use instead. Sourced, July 2026.",
    h1: "webhook.co vs RequestBin",
    lede: "RequestBin is the tool a lot of us learned webhooks on. The thing at that name today is a different product with a different deal, and the difference is worth knowing before you send it anything.",
    verifiedOn: CHECKED,
    whyLeave:
      "There is a good chance you got here by typing a URL from memory. You go to requestb.in, expect a bin, and get a signup form instead. Nothing is broken — the redirect works exactly as intended — but the property that made RequestBin worth remembering, that you could get a URL without an account or a decision, is not part of the deal any more.",
    distinctive:
      "This comparison is mostly a history lesson, because the honest answer to which is better depends on which RequestBin you mean. The original was Jeff Lindsay's HTTP inspector; Runscope took over the project and the hosted instance in August 2013, promising then to keep it free and to continue offering it without any registration requirements. That hosted instance was discontinued in March 2018 — Runscope said publicly it was because of ongoing abuse that made the site hard to keep up reliably — and the open-source repository is no longer on GitHub. Today both requestbin.com and the original requestb.in redirect to Pipedream, where RequestBin is the front door to a workflow platform and creating a bin requires an account. That is a perfectly reasonable product. It is not the one the muscle memory is for.",
    sections: [
      {
        id: "what-it-is-today",
        heading: "What you get at that URL today",
        body: "A capable workflow builder with a request bin at the entrance. You sign up, you get a durable endpoint on their domain (custom domains are supported), and captured requests can trigger steps written in Node, Python, Go or Bash, or one of a few thousand pre-built connectors. It will catch payloads far larger than most inspectors will look at. Billing is in credits rather than requests, and their free plan is a hundred credits a month with captured events kept for seven days and an average ingest rate of around ten requests a second before you start seeing 429s. If what you wanted was a bin, that is a lot of platform in the way; if what you wanted was a bin that then does something, it is the best answer on this page.",
      },
      {
        id: "signature-verification",
        heading: "Signature verification is code you write",
        body: "This one is a verified absence rather than an inference. Pipedream's own trigger documentation says HTTP triggers are public by default and require no authorization to invoke, and that they support two built-in authorization types: a static custom token, and OAuth. Neither of those is a provider signature check. So verifying that a request genuinely came from Stripe or GitHub means writing the HMAC comparison yourself in a workflow step, per source, and keeping it right as providers rotate schemes. We ship that for 141 providers as Apache-2.0 code you can read, and you can check a captured signature in the browser at our verifier without an account.",
      },
      {
        id: "no-signup",
        heading: "The no-signup property, and who still has it",
        body: "Worth being even-handed about, because we do not fully have it either. If your requirement is genuinely a URL in five seconds with no account, the honest recommendations are webhook.site, or our own sandbox, which needs no signup and no install. What an account buys you here is the part the sandbox deliberately does not do: an endpoint that belongs to you, keeps its captures, and can forward them to your machine. We would rather point you at the right free tool than pretend a signup is not a signup.",
      },
    ],
    chooseThem: {
      heading: "What Pipedream does better",
      body: "It is a genuinely strong product and the comparison is not close on breadth. Capturing a request is the beginning rather than the end: you get a real execution environment in four languages, thousands of connectors, and the ability to return a custom response to the caller, which means a bin can stand in for a service you have not written yet. It accepts payloads far larger than we do and supports custom domains on your endpoints, so the URL you hand a partner can carry your own name. Bins and their events are addressable from a REST API and a CLI, so this fits into continuous integration properly. If your next sentence after catching the webhook is and then send it to Slack and a spreadsheet, they have already built that and we have not.",
    },
    chooseUs: {
      heading: "Where we fit instead",
      body: "When the thing you want is a receiver rather than a workflow: verification you did not write, captures that keep, replay into a port on your laptop, and a bill that counts one thing. And when you would rather the verification path were open source, because a signature check you cannot read is a signature check you are taking on faith.",
    },
    table: [
      {
        label: "Create a bin without an account",
        them: "No — signup is required",
        us: "No account needed in the sandbox; an endpoint needs one",
        sourceId: "rb-page",
      },
      {
        label: "Captured event retention on the free plan",
        them: "7 days",
        us: "7 days",
        sourceId: "pd-pricing",
      },
      {
        label: "Free plan allowance",
        them: "100 credits/month, 3 active workflows",
        us: "5,000 captured events, once, then capture pauses",
        sourceId: "pd-pricing",
      },
      {
        label: "Ingest rate before throttling",
        them: "About 10 requests/second, then 429",
        us: "Not published as a per-second cap",
        sourceId: "pd-limits",
      },
      {
        label: "Built-in provider signature verification",
        them: "No — a static token or OAuth; HMAC is yours to write",
        us: "141 providers, Apache-2.0",
        sourceId: "pd-triggers",
      },
      {
        label: "Billing unit",
        them: "Credits, metered on compute time and memory",
        us: "Captured events",
        sourceId: "pd-glossary",
      },
      {
        label: "The original hosted requestb.in",
        them: "Discontinued in March 2018; the domain now redirects",
        us: "Not applicable",
        sourceId: "rb-archive",
      },
    ],
    migration: [
      {
        id: "find-the-bin",
        heading: "Work out which bin you actually have",
        body: "If you followed a bookmark and ended up signing up, your captures live in a Pipedream workflow rather than in anything called a bin, and you will find them under that workflow's event history. If you never signed up, there is nothing to move and this is a two-minute change.",
      },
      {
        id: "repoint",
        heading: "Repoint the provider, keep the old one running",
        body: "Add a second endpoint at the provider rather than editing the one in place. Same traffic, two destinations, and no window where a webhook has nowhere to go. Once you have seen a real event arrive on our side, remove the old one.",
      },
      {
        id: "rebuild-the-steps",
        heading: "Anything after the capture has to be rebuilt",
        body: "This is the honest cost. Workflow steps, connectors and custom responses have no equivalent here — we hand the event to your code or your agent and stop. If your bin had grown into a small integration, moving it means writing that integration somewhere, and you should count that before starting.",
      },
    ],
    faq: [
      {
        question: "What happened to requestb.in?",
        answer:
          "Runscope discontinued the publicly hosted instance in March 2018, saying it was due to ongoing abuse that made the site difficult to keep up reliably, and pointed people at self-hosting instead. The open-source repository is no longer on GitHub. Both requestb.in and requestbin.com now redirect to Pipedream's RequestBin page.",
      },
      {
        question: "Can you still use RequestBin without signing up?",
        answer:
          "No. Creating a bin on the current RequestBin leads to a Pipedream signup. That is a change from the original hosted service, which Runscope committed in 2013 to continue offering without registration requirements.",
      },
      {
        question: "Does RequestBin verify webhook signatures?",
        answer:
          "Not as a built-in per-provider feature. Pipedream's documentation states HTTP triggers are public by default and support two built-in authorization types, a static custom token and OAuth. Checking a provider HMAC signature means writing that comparison yourself in a workflow step.",
      },
      {
        question: "What is the closest thing to the old RequestBin today?",
        answer:
          "For a URL with no account at all, webhook.site or our own sandbox are the closest in spirit. For an endpoint that persists and keeps what it catches, you want a receiver with an account behind it, which is what this comparison is about.",
      },
    ],
    sources: [
      {
        id: "rb-page",
        label: "Pipedream — RequestBin",
        url: "https://pipedream.com/requestbin",
        checked: CHECKED,
      },
      {
        id: "pd-pricing",
        label: "Pipedream pricing",
        url: "https://pipedream.com/pricing",
        checked: CHECKED,
      },
      {
        id: "pd-limits",
        label: "Pipedream docs — workflow limits",
        url: "https://pipedream.com/docs/workflows/limits",
        checked: CHECKED,
      },
      {
        id: "pd-triggers",
        label: "Pipedream docs — HTTP triggers",
        url: "https://pipedream.com/docs/workflows/building-workflows/triggers",
        checked: CHECKED,
      },
      {
        id: "pd-glossary",
        label: "Pipedream docs — glossary, credits",
        url: "https://pipedream.com/docs/glossary",
        checked: CHECKED,
      },
      {
        id: "rb-archive",
        label: "Runscope RequestBin repository, archived March 2018",
        url: "https://web.archive.org/web/20180405072819/https://github.com/Runscope/requestbin",
        checked: CHECKED,
      },
    ],
  },
];

/** How many siblings each page links. A wrapping window keeps inbound links uniform by construction. */
export const RELATED_COUNT = 2;

export function getComparison(slug: string): Comparison | undefined {
  return COMPARISONS.find((c) => c.slug === slug);
}

export function comparisonPath(slug: string): string {
  return `/vs/${slug}`;
}

/**
 * The sibling strip. A wrapping window over a FIXED order — deliberately not similarity, alphabet or
 * curation — so every page receives exactly the same number of inbound sibling links no matter how
 * many are published. `comparisons.test.ts` measures that distribution rather than trusting it.
 */
export function relatedComparisons(slug: string): readonly Comparison[] {
  const start = COMPARISONS.findIndex((c) => c.slug === slug);
  // Callers always pass a published slug (the pages are generated from COMPARISONS), so an unknown
  // slug is a programming error rather than a runtime case to paper over with a plausible-looking
  // list of siblings.
  if (start === -1) throw new Error(`relatedComparisons: unknown comparison slug "${slug}"`);
  const count = Math.min(RELATED_COUNT, Math.max(COMPARISONS.length - 1, 0));
  return Array.from(
    { length: count },
    (_, i) => COMPARISONS[(start + 1 + i) % COMPARISONS.length]!,
  );
}

/**
 * The projection the near-duplicate guard sees: AUTHORED prose only.
 *
 * Everything the shared shell renders identically — section chrome, the table's column headers, the
 * CTA, the sources block — is excluded on purpose. Feeding boilerplate to a similarity check only
 * drags every pair towards each other and hides the very thing the check exists to find.
 */
export function comparisonText(c: Comparison): string {
  return [
    c.lede,
    c.whyLeave,
    c.distinctive,
    ...c.sections.flatMap((s) => [s.heading, s.body]),
    c.chooseThem.heading,
    c.chooseThem.body,
    c.chooseUs.heading,
    c.chooseUs.body,
    ...c.migration.flatMap((m) => [m.heading, m.body]),
    ...c.faq.flatMap((f) => [f.question, f.answer]),
  ].join(" ");
}
