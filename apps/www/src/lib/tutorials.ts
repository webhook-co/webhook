// Per-provider "test X webhooks locally" tutorials.
//
// These are AUTHORED, not generated, and that is a deliberate architectural split from the docs
// reference pages (`packages/webhooks-recipes/src/docs-page`, ADR-0129). Reference pages state
// machine-derived cryptographic facts, so generating them from the registry is right and a drift test
// pins them. A tutorial is narrative, and narrative cannot be templated: filling one prose template
// with per-provider facts measures 0.91 Jaccard against its siblings on `scripts/content-dup-guard.mjs`
// — over the 0.8 reject line — because the guard neutralizes the brand name before comparing, so
// swapping nouns changes nothing. Individually-written prose measures ~0.23. Hence: one author per
// provider, and no shared sentence stock beyond the CLI steps the shared component renders.
//
// Every factual claim here was researched from the provider's OWN documentation and then put through
// an adversarial fact-check. That pass is not decoration: it caught `orders/update` (Shopify's real
// topic is `orders/updated`), Teams' `missed` being Outlook-scoped, and Slack's `message.app_home`
// being defunct — each of which would have failed for a reader on first use.

import type { FaqItem } from "@/components/marketing/faq";

export interface TutorialGotcha {
  /** Sentence case, short. Rendered as an h3. */
  readonly heading: string;
  readonly body: string;
}

export interface Tutorial {
  /** Registry provider slug; also the URL segment (`/test/<slug>`). */
  readonly slug: string;
  /** Display name, used in headings and prose. */
  readonly name: string;
  /** `<title>`; the root template appends the brand, so it must not repeat it. */
  readonly title: string;
  readonly description: string;
  readonly h1: string;
  readonly lede: string;
  /**
   * What is genuinely different about testing THIS provider — the thing someone arriving from another
   * provider gets wrong. This is the field that earns the page its place; if it would read true of any
   * provider with the name swapped, the page should not ship.
   */
  readonly distinctive: string;
  /** Where in the provider you point it at an ingest URL. */
  readonly configure: string;
  /** How to actually make an event arrive — including "there is no test button" where that is the truth. */
  readonly fireTest: string;
  readonly eventsIntro: string;
  /** VERBATIM identifier strings. Never normalise these; a wrong one breaks for the reader immediately. */
  readonly eventExamples: readonly string[];
  readonly gotchas: readonly TutorialGotcha[];
  /**
   * Emitted as FAQPage structured data, so each question is a public claim a machine may quote back.
   * Questions must be unique across the whole site — `tutorials.test.ts` enforces it.
   */
  readonly faq: readonly FaqItem[];
}

/** The published set. Adding an entry publishes a page; it must also get a `MARKETING_ROUTES` row. */
export const TUTORIALS: readonly Tutorial[] = [
  {
    slug: "discord",
    name: "Discord",
    title: "Test Discord webhook events locally",
    description:
      "Discord's webhook events run the opposite way from incoming webhooks, and won't register until your handler answers the PING and checks the Ed25519 signature.",
    h1: "Catch Discord webhook events locally",
    lede: "Discord has two things called webhooks, pointing in opposite directions. This page is about the one that sends events to you — and about getting past the verification gate that guards it.",
    distinctive:
      "Two unrelated things share the name. The webhook URL an outside service posts to in order to push into Discord is incoming — nothing from Discord ever arrives at your app on it. What you test here is the opposite direction: Webhook Events, which Discord sends to your app. And the URL will not register at all until your handler already clears both halves of Discord's verification gate — the PING acknowledgement and the two signature headers. Verification is the first thing you debug, not the last.",
    configure:
      "The Webhooks page in your app's settings in the Discord Developer Portal is where this lives — left-hand sidebar. Drop the ingest URL into the Endpoint field, flip the Events toggle on, select the events you want your app to receive, and click Save Changes. Nothing flows until that URL is successfully verified. There's an API path too, if you'd rather not click: the docs point you at Edit Current Application.",
    fireTest:
      "There's no test button, no resend, no replay control anywhere in the documented flow. The one delivery you can summon is the PING that lands when you add or save the Webhook Events URL — which doubles as your handshake test. Everything else needs the real action behind it: authorize your app somewhere to produce APPLICATION_AUTHORIZED, or drive the real state change behind an ENTITLEMENT_CREATE.",
    eventsIntro:
      "Names are SCREAMING_SNAKE_CASE, but don't match on the top-level type field — that's a number, 0 for a PING and 1 for everything else. The name you actually care about sits one level down, in event.type, next to a timestamp and, when there is one, the payload.",
    eventExamples: [
      "APPLICATION_AUTHORIZED",
      "APPLICATION_DEAUTHORIZED",
      "ENTITLEMENT_CREATE",
      "ENTITLEMENT_UPDATE",
      "LOBBY_MESSAGE_CREATE",
      "GAME_DIRECT_MESSAGE_CREATE",
    ],
    gotchas: [
      {
        heading: "Three seconds, then backoff",
        body: "Discord expects a 204 with an empty body within three seconds. Miss the window and it retries several times using exponential backoff for up to ten minutes. Fail too often and it stops sending webhook events altogether and tells you by email. Worth knowing before you put a breakpoint in the handler.",
      },
      {
        heading: "Discord probes you with bad signatures",
        body: "Signature validation isn't advisory. Every request carries X-Signature-Ed25519 and X-Signature-Timestamp, you're expected to check both and answer 401 when they don't hold, and Discord runs routine automated checks that deliberately send invalid signatures. Fail one and it removes your Webhook Events URL, then notifies you by email and System DM.",
      },
      {
        heading: "Ordering is explicitly disclaimed",
        body: "The very first line of the docs says webhook events, unlike Gateway events, arrive when they arrive and in whatever order they arrive. Reconstruct sequence from the timestamp on the event body rather than from arrival order, and avoid state machines that assume a CREATE lands before its matching UPDATE.",
      },
      {
        heading: "You may not need this at all",
        body: "The docs put this plainly — if your app is using Gateway events, you don't need to configure a Webhook Events URL. Worth settling before you spend an afternoon on Ed25519 validation for an endpoint you were never going to need.",
      },
    ],
    faq: [
      {
        question: "Is a Discord webhook events URL the same as an incoming webhook?",
        answer:
          "No. An incoming webhook is a URL an external service posts to, so the traffic runs into Discord. A webhook events URL is the outgoing direction: Discord posts to your app when something happens in Discord. Only the second one delivers events you can inspect.",
      },
      {
        question: "Why won't Discord verify my webhook events URL?",
        answer:
          "Discord validates the URL only if your endpoint does two things first: acknowledges the PING it sends with a 204 and an empty body, including a valid Content-Type, and validates the two signature headers on every request. If either is missing, the URL is not validated.",
      },
      {
        question: "Can I resend a Discord webhook event for testing?",
        answer:
          "Discord documents no resend, redeliver, or replay control for webhook events. Real events require the underlying action, so capture one once and replay it locally instead.",
      },
    ],
  },
  {
    slug: "slack",
    name: "Slack",
    title: "Test Slack Events API webhooks locally",
    description:
      "Point Slack's Event Subscriptions at an ingest URL, clear the url_verification challenge, and stream real workspace events to localhost while you build.",
    h1: "Test Slack webhooks locally",
    lede: "Slack's Events API won't even save your Request URL until something on the other end answers a challenge. Clear that, and Slack's remaining rules are mostly about speed: three seconds to answer, or the same event comes back three more times.",
    distinctive:
      "Finish typing a Request URL into Event Subscriptions and Slack immediately POSTs a url_verification body carrying a challenge string; the form refuses to save until your endpoint answers 200 with that same string echoed back. A capture-everything tunnel that acknowledges with an empty body fails the check, and you never get past the form. webhook.co's ingest recognizes the handshake, echoes the challenge, and files nothing, so the green check mark appears and your event list stays free of setup noise.",
    configure:
      "Your app's settings live at api.slack.com/apps. Open the app, find Event Subscriptions, and flip the toggle on; a Request URL field appears, and that's where the ingest URL goes. Slack fires its challenge the moment you stop typing, and a green check mark means it took. If your endpoint was slow to wake and the first attempt timed out, the Retry button re-runs it. Slack also treats Request URLs as case-sensitive.",
    fireTest:
      "Slack documents no send-a-test-event control and no delivery log to redeliver from. The one request you can trigger on demand is the handshake, via that Retry button. Everything else means doing the real thing in a workspace: mention the app, post in a channel it watches, react to a message. Nothing reaches you until the Request URL clears its handshake, so get the green check mark first.",
    eventsIntro:
      "Identifiers are lowercase and underscore-separated, shaped object then action. Messages are the exception worth knowing: instead of a single message event there are dot-suffixed subscriptions per conversation type, so a DM and a public channel post are separate subscriptions.",
    eventExamples: [
      "app_mention",
      "message.channels",
      "message.im",
      "reaction_added",
      "member_joined_channel",
      "team_join",
    ],
    gotchas: [
      {
        heading: "Three seconds, then three retries",
        body: "Slack wants a 2xx inside three seconds. Miss it and the attempt counts as failed, after which Slack retries nearly immediately, then after a minute, then after five. Each attempt carries x-slack-retry-num and x-slack-retry-reason, whose documented values include http_timeout, too_many_redirects and ssl_error. A non-200 carrying x-slack-no-retry: 1 tells Slack to abandon that one event.",
      },
      {
        heading: "Slack can switch you off",
        body: "Cross more than 95% failed delivery attempts inside a 60-minute window and Slack temporarily disables the app's event subscriptions. The app's creator and owner get an email about it, and turning subscriptions back on is a manual trip through Slack app management. Apps taking fewer than 1,000 events an hour are exempt from the automatic disable.",
      },
      {
        heading: "Duplicates are your problem",
        body: "Slack's docs never commit to a delivery model, so treat the retry schedule as your duplicate story: a 2xx that arrives late earns you the same event twice. The outer wrapper carries an event_id that Slack documents as globally unique across all workspaces. It is the obvious dedup key, though Slack never nominates it as one.",
      },
      {
        heading: "A ceiling on hourly deliveries",
        body: "Deliveries top out at 30,000 per workspace per app per 60 minutes. Past the line Slack stops delivering and sends an app_rate_limited event for each minute you stay throttled; what becomes of the events above the cap is left unstated. Unlikely to bite in development, unpleasant to meet later.",
      },
    ],
    faq: [
      {
        question: "Why won't Slack save my Event Subscriptions Request URL?",
        answer:
          "Slack posts a challenge to the URL the instant you finish typing it, and refuses to save the form until your endpoint replies with a 200 and that same challenge value. webhook.co answers that handshake for you, so the check mark appears without you writing a line of handler code.",
      },
      {
        question: "Does Slack have a way to send a test webhook event?",
        answer:
          "Not one that Slack documents. Slack's Events API docs describe no sample-event control and no delivery log to redeliver from, so the only request you can fire on demand is the URL verification retry. For a real payload, perform the action in a workspace and inspect what lands.",
      },
      {
        question: "How fast does my app have to respond to a Slack event?",
        answer:
          "Three seconds, per Slack's docs. Miss it and the delivery counts as failed, and Slack retries nearly immediately, after one minute, and after five. With webhook.co in front, the acknowledgement comes from the ingest endpoint rather than from your laptop over a tunnel.",
      },
    ],
  },
  {
    slug: "stripe",
    name: "Stripe",
    title: "Test Stripe webhooks locally, end to end",
    description:
      "Point a Stripe event destination at a webhook.co ingest URL, fire a real test event, then inspect and replay it against the handler on your laptop.",
    h1: "Test Stripe webhooks locally",
    lede: 'A sandbox event and a live event travel different retry curves, which makes "it worked when I tested it" a weaker statement than it sounds. Getting a real Stripe event onto the laptop where the handler runs is the part worth wiring up carefully.',
    distinctive:
      "Stripe's event names are dotted strings that look easy to guess until they bite. A sub-resource gets its own segment, and it does not cascade: customer.subscription.updated fires nothing on customer.updated, so a destination subscribed to the parent sits silent while subscriptions churn. The second surprise is that retry behavior differs across the two halves of your test loop. An event created in a sandbox is retried three times over the course of a few hours; live mode backs off across three days. Tune a handler's failure path against sandbox timings and you have tuned it against the wrong curve.",
    configure:
      'Stripe keeps event destinations in Workbench, under the Webhooks tab. The button that starts a new one reads "Create an event destination" on Stripe\'s webhooks page and "Create new destination" inside Workbench itself. Two screens come before the interesting ones: which account the destination listens to, and which API version its event objects are rendered against. Then pick your event types, choose Webhook endpoint as the destination type, and drop the ingest URL into the Endpoint URL field. Registered endpoints have to be publicly accessible HTTPS URLs, and Stripe\'s webhook traffic speaks only TLS 1.2 and 1.3. You can register up to 16 webhook endpoints with Stripe, so prune dead ones before adding another. The same registration is available through the API.',
    fireTest:
      "Stripe's own CLI does the firing. Running stripe trigger payment_intent.succeeded fires a real test event rather than a canned sample. The other documented route is re-delivery rather than creation: Resend in the Dashboard, or stripe events resend from the CLI, both acting on an event that already exists. A Dashboard button for sending a fresh test event is not something Stripe's pages document.",
    eventsIntro:
      "Stripe names events resource.event: dot-separated, lowercase, with underscores living inside a segment rather than between them. A sub-resource earns an extra segment. The shape is regular enough to invite guessing, and the sub-resource rule is where guessing fails — the parent resource stays quiet when a sub-resource changes.",
    eventExamples: [
      "payment_intent.succeeded",
      "payment_intent.payment_failed",
      "checkout.session.completed",
      "charge.succeeded",
      "invoice.paid",
      "customer.subscription.deleted",
    ],
    gotchas: [
      {
        heading: "Sandbox retries give up early",
        body: "Live mode retries a failing destination with exponential backoff for up to three days. An event created in a sandbox gets three attempts across a few hours and then stops, so the retry pressure you observe while testing is far shorter than what a broken production handler will actually sit through.",
      },
      {
        heading: "A redirect is recorded as an error",
        body: "Stripe doesn't follow a 3xx on a webhook request — it logs the delivery as a failure, and tells you to register the URL the redirect resolves to. The rule that sits next to it on the same page: return the 2xx before any complex logic that could cause a timeout. An event showing a status code of 200 is what marks the delivery as successful.",
      },
      {
        heading: "Ordering isn't promised, repeats happen",
        body: "Stripe states plainly that events aren't delivered in the order they were generated, and that an endpoint might occasionally receive the same event more than once. The documented defense is to make the destination independent of order, log the event IDs you have processed, and skip anything already logged.",
      },
      {
        heading: "Five minutes of clock tolerance",
        body: "Stripe's signature libraries default to a five-minute tolerance between the Stripe-Signature timestamp and the current time, so a machine with a drifted clock will reject perfectly good payloads. Worth ruling out before you go hunting for a wrong signing secret.",
      },
    ],
    faq: [
      {
        question: "Does Stripe verify a webhook endpoint before it starts sending events?",
        answer:
          "Stripe documents no echo token and no GET challenge at registration. The verification it does document is HMAC signature checking on the Stripe-Signature header, which happens on every delivery rather than once at setup. The endpoint has to be a reachable, public HTTPS URL, and nothing more.",
      },
      {
        question: "How long after creation can a Stripe event be resent?",
        answer:
          "The Dashboard Resend action on a specific event works for up to 15 days after that event was created. The Stripe CLI resend command stretches the same idea to 30 days. Stripe documents no re-delivery path past those windows, so capture what you need while the event is fresh.",
      },
      {
        question: "Why doesn't customer.updated fire when a Stripe subscription changes?",
        answer:
          "Because Stripe treats a subscription as a sub-resource with its own slice of the event namespace. Changes surface as customer.subscription.updated and do not trigger a corresponding event for the parent resource. A destination subscribed only to the parent will never see subscription activity at all.",
      },
    ],
  },
  {
    slug: "github",
    name: "GitHub",
    title: "Test GitHub webhooks locally without deploying",
    description:
      "GitHub puts the event name in a header, never retries a failed delivery, and won't talk to localhost — three things that shape how you test it locally.",
    h1: "Test GitHub webhooks locally",
    lede: "GitHub's docs are blunt about it: you cannot use localhost or 127.0.0.1 as a payload URL. Deliveries originate from GitHub's servers and travel the public internet, so local testing needs a public URL that relays to your machine — plus an awareness of a few GitHub-specific behaviors that catch people out.",
    distinctive:
      "GitHub does not put the event name in the body. It arrives in the X-GitHub-Event header; the body carries at most an action property for the sub-activity, and push has no action at all. A handler that expects the event type in the body will not find it — action, where it exists, names the sub-activity, not the event. The second surprise lands right after: GitHub never retries. A failed delivery is recorded as failed and left there. Getting it back means clicking Redeliver, and only within the past 3 days.",
    configure:
      "Repository webhooks live under the repo's Settings, then Webhooks in the left sidebar, then Add webhook. The ingest URL goes into the Payload URL field. The Content type menu offers application/json and application/x-www-form-urlencoded — take JSON unless something downstream wants otherwise. A Secret is optional and worth setting. Finally, pick which events should trigger the hook.",
    fireTest:
      "There is no generic send-test button in the webhooks UI. What you get for free is the ping GitHub fires automatically the moment the webhook is created, confirming you set it up correctly. After that, testing means performing the actual action — open an issue, push a commit — or opening Recent deliveries, clicking a delivery GUID, and choosing Redeliver. The REST API mirrors all of it: POST /repos/{owner}/{repo}/hooks/{hook_id}/pings, and POST /repos/{owner}/{repo}/hooks/{hook_id}/tests, which re-sends the latest push to push-subscribed hooks only.",
    eventsIntro:
      "Names are lowercase snake_case resource nouns with the verb stripped off — the thing, not what happened to it. The specific activity usually rides in the payload's action property (opened, closed, published), while the name itself arrives in the X-GitHub-Event header. A few events, push among them, carry no action at all.",
    eventExamples: ["push", "pull_request", "issues", "issue_comment", "release", "workflow_run"],
    gotchas: [
      {
        heading: "GitHub does not retry",
        body: "A failed delivery stays failed. No backoff schedule, no second attempt — the failure is recorded and that is the end of it. Your only recourse is Redeliver — from the Recent deliveries tab or the delivery attempts REST route — and only for deliveries from the past 3 days. Outside that window the delivery can no longer be replayed at all.",
      },
      {
        heading: "Ten seconds, then the connection drops",
        body: "GitHub wants a 2XX within 10 seconds. Take longer and it terminates the connection and counts the delivery as a failure. Return any 4xx or 5xx and it records a failure too. The documented advice is to acknowledge first and process the payload asynchronously.",
      },
      {
        heading: "Redelivery reuses the delivery GUID",
        body: "A redelivered event carries the same X-GitHub-Delivery value as the original. Handy for tracing, awkward for deduplication: that header on its own cannot tell you whether you are looking at a resend of something already handled or a genuine first arrival. Build idempotency around what the payload means, not the GUID.",
      },
      {
        heading: "Payloads are capped at 25 MB",
        body: "If an event generates a larger payload, GitHub will not deliver a payload for that webhook event.",
      },
    ],
    faq: [
      {
        question: "Does GitHub retry failed webhook deliveries?",
        answer:
          "No. GitHub records the failure and moves on — there is no automatic redelivery. Recovering an event means opening Recent deliveries, selecting it, and clicking Redeliver, which works only for deliveries from the past 3 days. The same 3-day window governs how far back the delivery log goes.",
      },
      {
        question: "Can I point a GitHub webhook at localhost?",
        answer:
          "No. GitHub's documentation states outright that you cannot use localhost or 127.0.0.1 as a webhook URL, since deliveries come from GitHub's own servers across the public internet. The documented recommendation is a webhook forwarding service that holds a publicly reachable URL and relays each delivery to your machine.",
      },
      {
        question: "How do I tell which GitHub event I just received?",
        answer:
          "Read the X-GitHub-Event header. GitHub does not put the event name in the JSON body. Most payloads carry an action property naming the specific activity, such as opened or closed, but several events, push among them, have no action property at all.",
      },
    ],
  },
  {
    slug: "shopify",
    name: "Shopify",
    title: "How to test Shopify webhooks locally",
    description:
      "Point Shopify at a capture URL, stream orders/create and friends into localhost, and survive a five-second delivery window without losing the subscription.",
    h1: "Test Shopify webhooks locally",
    lede: "Five seconds is the whole delivery budget, and Shopify's supply of second chances runs out. A capture URL in front of your handler decouples the two.",
    distinctive:
      "Shopify's answer to a failing endpoint doesn't stop at the failed delivery. After eight consecutive failures the subscription itself is removed, for subscriptions created through the Admin API — that's what Shopify documents, not an edge case. The delivery budget is one second to connect and five seconds for the entire request, and any status outside the 200 range counts as an error, 3XX redirects included. Put a tunnel in front of your laptop and a debugger breakpoint doesn't only cost you one event — it can quietly unregister the thing you were testing. Acknowledge from a capture URL and replay at your own pace.",
    configure:
      "Store owners create subscriptions in the Shopify admin under Settings, then Notifications, then Webhooks, where Create webhook asks for the event, JSON or XML, the destination URL, and a webhook API version. The event can't be changed after creation, so a wrong pick means a fresh subscription. App developers instead put the ingest URL in the uri key of a webhooks.subscriptions block in shopify.app.toml, alongside a topics array holding the events they want, or create a shop-specific subscription with the webhookSubscriptionCreate mutation on the GraphQL Admin API.",
    fireTest:
      "Every saved webhook in the admin carries a Send test option behind the ... overflow menu on its row, which fires a sample notification at the URL you registered. App builds get shopify app webhook trigger, which delivers a sample Admin API topic payload to an address you name, localhost ports included. Two caveats straight from Shopify's CLI reference: the triggered payload never varies, and triggered webhooks aren't retried when they fail.",
    eventsIntro:
      "Topics are lowercase resource/action pairs split by a slash — noun first, verb second. The GraphQL Admin API publishes the same set as SCREAMING_SNAKE_CASE enums, so ORDERS_CREATE and orders/create are one topic in two dialects. Mind the spelling: Shopify writes cancelled with two Ls.",
    eventExamples: [
      "orders/create",
      "orders/paid",
      "orders/updated",
      "orders/cancelled",
      "products/update",
      "app/uninstalled",
    ],
    gotchas: [
      {
        heading: "Five seconds, then it's an error",
        body: "One second to open the connection, five seconds for the whole request. Anything outside the 200 range is failure, and that explicitly includes 3XX — so a trailing-slash redirect on your route is scored as a failed delivery rather than a hop Shopify takes. Acknowledge with 200 OK first, do the work afterwards.",
      },
      {
        heading: "Failed deliveries can unregister you",
        body: "A failure earns eight retries, spread over four hours per Shopify's HTTPS delivery page, and eight consecutive failures delete an Admin-API-created subscription. Shopify's own troubleshooting page words the removal window as a 24-hour period instead, so treat the exact figure as unsettled and the outcome as real.",
      },
      {
        heading: "Duplicates arrive, order doesn't hold",
        body: "Shopify doesn't promise ordering within a topic or across topics touching the same resource, and says outright that delivery isn't assured. Deduplicate on X-Shopify-Webhook-Id, sequence with X-Shopify-Triggered-At or the payload's updated_at, and keep a reconciliation job that reads the API for whatever never turned up.",
      },
      {
        heading: "localhost isn't a deliverable destination",
        body: "Shopify won't deliver webhooks to localhost, to any URL ending in the word internal, to fake domains, to Shopify domains, or to a custom domain attached to the store. Deliveries go out to an https:// URI with SSL certificates verified on delivery, so the destination has to be publicly reachable and terminate TLS properly.",
      },
    ],
    faq: [
      {
        question: "Why did Shopify delete my webhook subscription while I was testing?",
        answer:
          "Consecutive failed deliveries remove a subscription that was created through the Admin API — see the delivery-window gotcha above for how few it takes and why Shopify's own pages disagree on the window. An endpoint that was stopped at a breakpoint, slow, or answering with a redirect is enough to get there. Keeping a capture URL in front of your machine absorbs those failures instead.",
      },
      {
        question: "Does the Shopify CLI webhook trigger command replace real store events?",
        answer:
          "Not for anything that branches on payload contents. Shopify documents that webhooks triggered this way always carry the same sample payload, and that they are not retried when they fail. Use it to prove routing and signature handling, then drive a real order through the store.",
      },
      {
        question: "Which header does Shopify sign webhook deliveries with?",
        answer:
          "Shopify's docs render it as X-Shopify-Hmac-SHA256. There is no subscribe-time challenge or echo to answer, so verification is always after the fact, per delivery, rather than something you prove once at registration.",
      },
    ],
  },
  {
    slug: "atlassian_jira",
    name: "Jira",
    title: "Test Jira webhooks locally without deploying",
    description:
      "Jira Cloud demands HTTPS on an allowlisted port and offers no test-send button. Catch real Jira issue and comment events on localhost anyway.",
    h1: "Test Jira webhooks locally",
    lede: "Jira Cloud won't post to your laptop, and there's no test button to tell you so. The way in is a public HTTPS URL on a port Atlassian will actually dial, forwarded down to your machine.",
    distinctive:
      "You can usually point a webhook wherever you like and sort out reachability afterwards. Jira Cloud decides up front whether it will talk to you at all: the URL has to be HTTPS with a certificate signed by a globally trusted authority, and the destination port must sit on Atlassian's allowlist — 443, 8443, 8080, 1880-1890 and a short list of others, with port 80 refused outright. There's also no test-send control anywhere in the admin UI, so an unreachable endpoint stays quiet until someone does real work in a project. Get the URL accepted first, then go hunting for events.",
    configure:
      "You need the Administer Jira global permission to touch webhooks at all. From there it's Settings, then System, then WebHooks under the Advanced heading. Create a new webhook, paste your ingest URL, and tick the events you want. Leave Exclude body alone — checking it strips the JSON payload. The optional Secret field is write-once: Jira won't show it to you again after save.",
    fireTest:
      "Nothing in Jira replays or synthesises a delivery. Atlassian's own testing guide has you perform the real action and then go look at your endpoint, which is the whole method. So pick a scratch project, subscribe to jira:issue_created and jira:issue_updated, create an issue and edit its summary — two deliveries, both genuine. Comment and worklog events need their own actions: leave a comment, log some time.",
    eventsIntro:
      "Identifiers are snake_case resource_action pairs, but the namespacing is inconsistent enough to catch you out. Issue and version events carry a jira: prefix; comment, worklog, sprint and project events don't. Don't extrapolate the rule: jira_expression_evaluation_failed uses an underscore rather than the colon, and worklog events lost their prefix in a deprecation rather than by rule. The prefixed jira:worklog_updated is on its way out; worklog_updated replaces it. The same string reappears in the payload's webhookEvent field.",
    eventExamples: [
      "jira:issue_created",
      "jira:issue_updated",
      "jira:issue_deleted",
      "comment_created",
      "comment_updated",
      "worklog_created",
    ],
    gotchas: [
      {
        heading: "Retries are slow and selective",
        body: "Only 408, 409, 425, 429, any 5xx, and connection failures or timeouts earn a retry. A 400 or 404 counts as a failed trigger but is never resent. Jira Cloud retries up to five times, each attempt landing five to fifteen minutes after the last, and after roughly half an hour of continuous failure it degrades to a single attempt per webhook. Retried requests carry X-Atlassian-Webhook-Retry.",
      },
      {
        heading: "The secret is write-once",
        body: "Fill in the Secret field and Jira Cloud signs the raw request body with HMAC, sending X-Hub-Signature formatted as method=signature. Read the algorithm out of the method prefix rather than assuming sha256. Once saved, the secret can't be viewed or retrieved, so keep your own copy. Webhooks registered dynamically by OAuth 2.0 apps use bearer authentication instead.",
      },
      {
        heading: "Duplicates and out-of-order arrivals",
        body: "Delivery is at-least-once, so dedupe on X-Atlassian-Webhook-Identifier, which is unique within a Jira Cloud tenant and stable across retries of the same event. Ordering is never promised: Jira opens many concurrent connections per tenant and URL host, more for primary-flow webhooks than for secondary bulk ones, and X-Atlassian-Webhook-Flow tells you which class you received. Payloads over 25 MB are dropped rather than retried, and Atlassian reserves the right to move that number without notice.",
      },
      {
        heading: "Cloud rules aren't Data Center rules",
        body: "All of the above comes from Atlassian's Jira Cloud webhooks documentation. The Server and Data Center page shares only the part about a 200 meaning success: it documents no retry schedule, no payload ceiling, no delivery-time expectation and no HTTPS requirement. If you're building against self-hosted Jira, assume none of the Cloud behaviour carries over.",
      },
    ],
    faq: [
      {
        question: "Does Jira Cloud sign its webhook requests?",
        answer:
          "Yes, if you set a secret. Admin-created Jira Cloud webhooks accept an optional secret; when one is present, Jira signs the raw request body with HMAC and sends an X-Hub-Signature header shaped as method equals signature. Parse the algorithm from the method prefix rather than assuming sha256. The secret cannot be retrieved after saving.",
      },
      {
        question: "Can a Jira webhook deliver straight to localhost?",
        answer:
          "No. Jira Cloud accepts only HTTPS URLs whose certificate is signed by a globally trusted authority, and the destination port must appear on its allowlist, with port 80 disallowed. Point Jira at a public HTTPS ingest URL and forward from there down to your machine.",
      },
      {
        question: "Do Jira Cloud retry and size limits apply to Jira Data Center?",
        answer:
          "No. The Server and Data Center webhooks documentation confirms only that a 200 response means success. It sets out no retry schedule, no payload size ceiling, no delivery-time expectation and no HTTPS-only rule, so none of the Cloud behaviour should be assumed on self-hosted Jira.",
      },
    ],
  },
  {
    slug: "gitlab",
    name: "GitLab",
    title: "Test GitLab webhooks locally without deploying",
    description:
      "Point a GitLab project or group webhook at a real URL, see exactly what GitLab sends, and replay it against your local server.",
    h1: "Test GitLab webhooks locally",
    lede: "GitLab webhooks live on a project or a group, name their events three different ways at once, and switch themselves off if your endpoint misbehaves four times running.",
    distinctive:
      "GitLab names the same event three different ways, and you'll meet all three. The X-Gitlab-Event header carries a title-cased string like Merge Request Hook. The JSON body carries the same event in snake case as object_kind, reading merge_request. The API subscribes with boolean flags that are plural where the header is singular: merge_requests_events. Route on whichever you prefer, but expect the other two in logs and bug reports. A second trap sits underneath: an Issue Hook doesn't always carry object_kind issue — for other work items the field reads work_item.",
    configure:
      "You need the Maintainer or Owner role on a project, or Owner on a group. From the top bar use Search or go to, find the project or group, then Settings > Webhooks > Add new webhook. Enter the URL, percent-encoding any special characters. GitLab ranks the request-authentication options for you: signing token recommended, secret token explicitly not recommended. Choose your events in the Trigger section and select Add webhook.",
    fireTest:
      "Each saved webhook gets a Test dropdown: pick an event type and GitLab posts a sample payload. Not every event type is testable, and a push test needs the project to have at least one commit. Past deliveries sit under Recent events with a Resend Request button that replays the same body under the same Idempotency-Key — though not once you've changed the webhook URL. Both test and resend are capped at five requests per minute.",
    eventsIntro:
      "These are X-Gitlab-Event header values, GitLab's user-facing name for each hook: title case, singular, each suffixed with Hook. The body's object_kind gives you the same event in snake case, and the API's subscription flags give a third, pluralised form of it.",
    eventExamples: [
      "Push Hook",
      "Tag Push Hook",
      "Issue Hook",
      "Merge Request Hook",
      "Note Hook",
      "Pipeline Hook",
    ],
    gotchas: [
      {
        heading: "Four failures and it switches off",
        body: "GitLab.com disables a webhook that fails four consecutive times — 4xx, 5xx, timeouts and other HTTP errors all count. The first block lasts a minute and backs off toward 24 hours before automatically re-enabling; 40 consecutive failures disable it permanently. A test request returning 2xx brings it back. On GitLab Self-Managed, auto-disabling of project webhooks sits behind the auto_disabling_web_hooks feature flag, and the permanent 40-failure state arrived in 17.11.",
      },
      {
        heading: "Ten seconds is the whole budget",
        body: "On GitLab.com the delivery timeout is 10 seconds, and a timeout counts toward auto-disabling. The docs are blunt about the shape they want: answer 200 or 201 quickly, put the work on a queue, don't process it inside the request. Self-managed instances set their own value through the gitlab_rails webhook_timeout setting, which the configuration example in the docs shows at 60 seconds.",
      },
      {
        heading: "Local addresses are blocked on self-managed",
        body: "GitLab Self-Managed and Dedicated refuse webhook requests to the instance's own address and to private ranges — 127.0.0.1, ::1, 0.0.0.0, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 and IPv6 site-local — until an administrator selects Allow requests to the local network from webhooks and integrations under Admin > Settings > Network > Outbound requests. On GitLab.com that setting isn't yours to change. Either way, give GitLab a public URL.",
      },
      {
        heading: "A large push can send nothing",
        body: "GitLab caps how many branches or tags one push may touch before the push event stops firing at all: push_event_hooks_limit, which kicks in above three. A branch-heavy push therefore produces silence rather than a burst, which looks exactly like a dead endpoint when the endpoint is fine. Worth ruling out before you go hunting through your own logs.",
      },
      {
        heading: "One noisy webhook stalls the namespace",
        body: "Webhook calls are rate-limited per top-level namespace, and every project and group webhook in that namespace shares the budget — 500 per minute on Free, rising with plan and seat count to 13,000. Hit the ceiling and GitLab temporarily disables all webhooks in the namespace until the next minute, not only the one that overran.",
      },
      {
        heading: "Duplicates are yours to absorb",
        body: "GitLab publishes no delivery guarantee, but does tell you to prepare for duplicate events when a webhook times out. Every request carries an Idempotency-Key header, with webhook-id as the newer name for the same value, and the value survives retries and manual resends — so dedupe on it. Recent events keeps only the last two days, so debug while the evidence is still there.",
      },
    ],
    faq: [
      {
        question: "Does GitLab have a way to send a test webhook?",
        answer:
          "Yes. Each saved webhook has a Test dropdown that fires a sample payload for the event type you pick. Testing is not supported for every event type, and a push test needs the project to have at least one commit. Test and resend are both limited to five requests per minute.",
      },
      {
        question: "Why did my GitLab webhook stop firing?",
        answer:
          "Most likely GitLab disabled it. On GitLab.com, four consecutive failures, counting 4xx, 5xx, timeouts and other HTTP errors, temporarily disable a webhook, backing off from one minute toward 24 hours; forty consecutive failures disable it for good. A test request returning 2xx re-enables it. On GitLab Self-Managed, auto-disabling of project webhooks sits behind the auto_disabling_web_hooks feature flag.",
      },
      {
        question: "Can I point a GitLab webhook at localhost?",
        answer:
          "Not directly. GitLab Self-Managed and Dedicated block requests to private network ranges until an administrator enables outbound requests to the local network, and on GitLab.com that setting is not available to you at all. Give GitLab a publicly reachable URL and forward from there.",
      },
      {
        question: "How does GitLab tell me which event fired?",
        answer:
          "Three ways at once. The X-Gitlab-Event header carries a title-cased name such as Merge Request Hook. The JSON body repeats the same event in lower-case snake form. The API subscribes using plural boolean flags. Route on whichever you like, but expect all three in the wild.",
      },
      {
        question: "Does GitLab retry a failed webhook delivery?",
        answer:
          "Not in any documented way. GitLab describes automatic disabling of failing webhooks and a manual Resend Request button, but publishes no retry count or backoff schedule. It does tell you to expect duplicate events after a timeout, so dedupe on the idempotency key.",
      },
      {
        question: "Which IP addresses does GitLab.com send webhooks from?",
        answer:
          "GitLab.com sends webhook traffic from its Web and API fleet range, 34.74.90.64/28 and 34.74.226.0/24, allocated solely to GitLab. If your receiver sits behind an allowlist, those are the ranges to permit. The no static IPs caveat in the docs applies to CI/CD runners, not to webhooks.",
      },
    ],
  },
  {
    slug: "hubspot",
    name: "HubSpot",
    title: "Test HubSpot webhooks on your local machine",
    description:
      "HubSpot batches up to 100 events per POST, retries for 24 hours, and promises no ordering. What that means when you test a HubSpot subscription locally.",
    h1: "Test HubSpot webhooks locally",
    lede: "HubSpot delivers in batches, retries for a day, and guarantees neither order nor uniqueness. Most of the surprises in local testing come from those three facts.",
    distinctive:
      "A HubSpot delivery is not an event. HubSpot batches up to 100 events into a single POST, and the five-second timeout applies to the whole batch rather than to each event inside it. Nothing in that batch is ordered either: HubSpot does not guarantee notifications arrive in the order they occurred, does not guarantee only one notification per event, and states outright that eventId is not guaranteed to be unique. You order by each notification's occurredAt millisecond timestamp and deduplicate yourself. Locally, the first symptom is a handler written for one notification being handed a batch of them.",
    configure:
      "Which kind of app you built decides where the target URL lives. In a legacy private app created through the UI: Development, then Legacy apps, your app, the Webhooks tab, Edit webhooks, Target URL, Create subscription, Commit changes. Legacy private apps built with projects do not currently support webhook subscriptions, and there is no API for managing private-app subscriptions. On the current developer platform there is no UI step — targetUrl goes in a -hsmeta.json file inside src/app/webhooks/.",
    fireTest:
      "HubSpot ships a test button for this. On the Webhooks tab, hover a subscription, click View details, then click Test: HubSpot sends the sample event payload listed in the panel to your configured target URL and shows your endpoint's response at the bottom. Legacy public apps have the equivalent Test this subscription flow. It is a canned sample, so read it as a shape check, not a data check.",
    eventsIntro:
      "Subscription types read as object then action: the object lowercase, snake_case when it is two words, and the action in lowerCamelCase — creation, deletion, propertyChange, associationChange, restore, merge, privacyDeletion, newMessage. A generic form using object.creation style types also exists, but it is a public beta scoped to public apps and carries the object type in the payload's objectTypeId field.",
    eventExamples: [
      "contact.creation",
      "contact.propertyChange",
      "contact.deletion",
      "company.propertyChange",
      "deal.creation",
      "conversation.newMessage",
    ],
    gotchas: [
      {
        heading: "Five seconds covers the whole batch",
        body: "The clock is per POST, not per event. If your service takes longer than five seconds to send back a response to a batch of notifications, HubSpot treats it as a failure — as it does a connection failure, or any 4xx or 5xx status. A 2xx acknowledges receipt. Design the handler around that budget, because a hundred events can share it.",
      },
      {
        heading: "Retries run for a day",
        body: "Failed notifications are retried up to 10 times, spread over the next 24 hours with varying delays and per-notification randomization so concurrent failures do not all come back at once. No per-attempt schedule is published. Every payload carries attemptNumber, starting at 0, so your handler can tell a first delivery from a retry.",
      },
      {
        heading: "Settings are cached for up to five minutes",
        body: "Webhook settings can be cached for up to five minutes, so a change to the target URL, the concurrency limit or the subscriptions themselves may take that long to take effect. Concurrency is 10 in-flight requests per account that installed your app, and it is an adjustable setting rather than a fixed ceiling.",
      },
      {
        heading: "Signatures are v3, with their own five minutes",
        body: "Requests are signed with X-HubSpot-Signature-v3, lowercase v, alongside X-HubSpot-Request-Timestamp. Validation is a base64 HMAC-SHA256 over request method, request URI, request body and timestamp, keyed on the app's client secret and compared in constant time, rejecting anything with a timestamp older than five minutes. Two unrelated five-minute numbers, worth keeping straight.",
      },
      {
        heading: "The logs tab shows, it does not resend",
        body: "Past deliveries live under the app's Logs tab, then Webhooks: a filterable history of successful and unsuccessful requests you can drill into. No redelivery or resend action is documented there. Once the 24-hour retry window closes on a delivery you missed, the log entry is the record you are left with.",
      },
      {
        heading: "The journal API is a different surface",
        body: "HubSpot's newer webhooks journal is polled rather than pushed — subscriptions are written to a journal your app reads, and there is no targetUrl anywhere in it. The path /docs/api/webhooks now serves that journal documentation, so it is easy to land there while looking for push-delivery behaviour and read the wrong thing.",
      },
    ],
    faq: [
      {
        question: "Can I test a HubSpot webhook subscription without editing a record?",
        answer:
          "Yes. On the Webhooks tab of your app, hover the subscription, click View details, then click Test. HubSpot sends the sample event payload shown in that panel to your target URL and displays your endpoint's response at the bottom of the panel.",
      },
      {
        question: "Why does my HubSpot webhook handler receive a batch instead of one event?",
        answer:
          "Because HubSpot batches. Each request can contain up to 100 events, delivered against a concurrency limit of 10 in-flight requests per account that installed your app. Handle the body as a batch of notifications, and remember the five-second response budget covers the whole batch.",
      },
      {
        question: "Does HubSpot require HTTPS for the webhook target URL?",
        answer:
          "Yes. The target URL must be publicly available and served over HTTPS. That is why a bare localhost port will not work as a target on its own, and why the URL you register has to be one HubSpot can reach from the public internet.",
      },
      {
        question: "How do I verify a HubSpot webhook signature?",
        answer:
          "Current requests carry the X-HubSpot-Signature-v3 header, lowercase v, plus X-HubSpot-Request-Timestamp. Compute a base64 HMAC-SHA256 over the request method, request URI, request body and timestamp using your app's client secret, compare it in constant time, and reject timestamps older than five minutes.",
      },
      {
        question: "Can I replay a past HubSpot webhook delivery?",
        answer:
          "Not from the HubSpot UI. The Logs tab under Webhooks lets you review and filter successful and unsuccessful requests, but no resend action is documented. HubSpot's own retries are automatic: up to 10 attempts spread across the following 24 hours.",
      },
      {
        question: "Why hasn't my new HubSpot target URL taken effect yet?",
        answer:
          "Webhook settings can be cached for up to five minutes. Changes to the webhook URL, the concurrency limits or the subscription settings may take that long to go live, so a stale delivery destination right after an edit is expected rather than broken.",
      },
      {
        question: "Does HubSpot send a verification request to my URL before delivering?",
        answer:
          "No handshake or challenge protocol is documented. Deliveries themselves are POST requests. The testing guidance does say to have a backend service ready with GET and POST endpoints available, but it describes no challenge value your endpoint has to echo back.",
      },
    ],
  },
  {
    slug: "twilio",
    name: "Twilio",
    title: "Test Twilio webhooks on localhost",
    description:
      "Twilio ships two unrelated webhook systems — per-number TwiML callbacks and Event Streams sinks. See what each one actually sends before you write a handler.",
    h1: "Test Twilio webhooks locally",
    lede: "Twilio has two webhook systems that behave differently enough to count as two integrations. Here's what changes depending on which one is pointed at your machine.",
    distinctive:
      "The thing that catches people out is that Twilio doesn't have a webhook system — it has two, and they share almost nothing. Classic webhooks hang off a phone number, have no event names at all, and expect TwiML back. Event Streams is account-wide: you create a webhook Sink, then a Subscription naming event types and a schema version, and Twilio POSTs JSON. Timeouts differ, failure semantics differ, and a test facility exists for one and not the other. Work out which one you're receiving before you debug anything, because the answers are not interchangeable.",
    configure:
      "For a phone number, set the webhook URL in the Twilio Console, or POST to the IncomingPhoneNumbers resource with SmsUrl, SmsMethod, VoiceUrl, VoiceMethod or StatusCallback — the Twilio CLI updates the same fields. Event Streams needs two objects instead: a Sink with sink_type webhook, whose sink_configuration carries your destination and method, then a Subscription listing each event type alongside its schema_version.",
    fireTest:
      "Event Streams has a real one: a Sink Test endpoint at events.twilio.com that initiates a test event on a Sink and answers with a result of submitted. What lands on your endpoint isn't documented, so watch what actually arrives rather than assuming. Phone-number webhooks have no documented test-send control. The route Twilio documents is live traffic — message or call the number — then the Console Debugger, which lists any errors Twilio finds when it sends a webhook to your application.",
    eventsIntro:
      "Only Event Streams names things. In practice the identifiers are reverse-DNS and dot-separated: product, then resource, then a past-tense action. Each type is pinned to a numbered schema_version that advances per event type rather than globally, and Twilio recommends subscribing to the latest version of an event.",
    eventExamples: [
      "com.twilio.messaging.inbound-message.received",
      "com.twilio.messaging.message.queued",
      "com.twilio.messaging.message.sent",
      "com.twilio.messaging.message.delivered",
      "com.twilio.messaging.message.undelivered",
      "com.twilio.messaging.message.failed",
    ],
    gotchas: [
      {
        heading: "Two timeout budgets, not one",
        body: "A webhook Sink response gets a maximum of five seconds. A classic webhook gets a 5000 ms connect timeout, a 15000 ms read timeout and 15000 ms total time, with a retry count of 1 and a retry policy of ct by default. Those overrides ride along as fragments on the webhook URL, and aren't available for Twilio Conversations or Frontline. Voice adds a hard 15-second cap on all call-related HTTP requests.",
      },
      {
        heading: "Event Streams is at-least-once",
        body: "Twilio retries a failed sink delivery for up to four hours, with exponential backoff plus jitter, so there's no fixed retry count to plan around. Retries mean duplicates. The prescribed fix is to key on the event id: discard if you've seen it, store it if you haven't, and return 200 even for the discards, or Twilio keeps retrying.",
      },
      {
        heading: "Status callbacks arrive out of order",
        body: "There's no guarantee that status callback requests reach your endpoint in the order they were sent, so a queued landing after a delivered is normal rather than a bug. Twilio wants an HTTP 200 back and requires no response content. Write the state machine to tolerate transitions in any order instead of assuming a sequence.",
      },
      {
        heading: "You can't allowlist Twilio's IPs",
        body: "Twilio uses a cloud architecture and doesn't have a fixed range of IP addresses that issue webhooks. Authenticate on the X-Twilio-Signature header instead: HMAC-SHA1 over the exact URL you gave Twilio plus the request parameters, keyed with your account auth token. On WebSocket requests the header name is lowercase. Twilio also won't connect to an HTTPS URL with a self-signed certificate.",
      },
      {
        heading: "Fallback URLs are a separate mechanism",
        body: "SmsFallbackUrl and VoiceFallbackUrl fire when an error occurs requesting or executing the TwiML from the primary URL. That's a different trigger from the connection-override retry policy — one covers the TwiML your application returns, the other covers the connection used to fetch it. Conflating them makes fallback traffic look like a network problem.",
      },
      {
        heading: "The sink body is an array",
        body: "An Event Streams webhook delivers a JSON array. Today it contains only one event, and Twilio's own advice is to iterate anyway to future-proof the implementation. A handler that reads element zero and moves on works fine right up until the day the array grows a second entry.",
      },
    ],
    faq: [
      {
        question: "Does Twilio let you send a test webhook?",
        answer:
          "For Event Streams, yes — there's an API endpoint that initiates a test event on a Sink and responds with a result of submitted. For phone-number webhooks, Twilio documents no test-send control. The documented approach there is real traffic plus the Console Debugger.",
      },
      {
        question: "How do I verify a webhook actually came from Twilio?",
        answer:
          "Check the X-Twilio-Signature header. It's an HMAC-SHA1 over the exact URL you gave Twilio plus the request parameters, keyed with your account auth token. IP allowlisting isn't an option, because Twilio has no fixed range of addresses that issue webhooks. On WebSocket requests the header name is lowercase.",
      },
      {
        question: "Can Twilio Event Streams deliver the same event twice?",
        answer:
          "Yes. Event Streams guarantees at-least-once delivery, and retries can produce duplicates. Twilio's guidance is to check whether you already received an event with the same id, discard the incoming event if so, store the id if not, and return 200 even for the discards.",
      },
      {
        question: "How long does Twilio wait for my endpoint to respond?",
        answer:
          "It depends which system you're on. A webhook Sink response has a maximum timeout of five seconds. A classic phone-number webhook defaults to a 5000 ms connect timeout with 15000 ms read and total time, tunable per URL, and call-related requests carry a hard upper timeout of 15 seconds.",
      },
      {
        question: "Does Twilio require a publicly reachable URL?",
        answer:
          "For phone-number webhooks, yes — Twilio needs to send webhook requests to a publicly available URL, so a bare localhost address won't do. It also won't connect to an HTTPS URL with a self-signed certificate, which rules out most quick local TLS setups.",
      },
    ],
  },
  {
    slug: "ms_teams",
    name: "Microsoft Teams",
    title: "Test Microsoft Teams webhooks locally",
    description:
      "Microsoft Teams Outgoing Webhooks are synchronous, HMAC-signed, and fired by an @mention. What to know before pointing one at a capture URL.",
    h1: "Test Microsoft Teams webhooks locally",
    lede: "Microsoft Teams has two unrelated ways to push activity at your code — Outgoing Webhooks and Microsoft Graph change notifications — with different setup, different auth, and different delivery rules. Sorting out which one you're wiring up saves an afternoon.",
    distinctive:
      "Two things about Teams Outgoing Webhooks catch developers out. First, there's no event catalogue and no subscription screen: the only documented trigger is a person @mentioning the webhook by name, and only in a public channel of the team it was created in — never in personal or private scope. Second, delivery is synchronous and reply-shaped. Teams issues an HTTP request, your code gets five seconds to respond before the connection times out, and whatever you return is posted back into the same reply chain. A handler that acknowledges and defers has nothing to say in the thread.",
    configure:
      'In the Teams client, select Teams in the left pane, pick the team, hit ••• and choose Manage team, open the Apps tab, and under Upload an app select Create an outgoing webhook. Fill in Name, Callback URL — the HTTPS endpoint that accepts JSON payloads and receives POST requests from Teams — and Description. On Create, an HMAC dialogue appears with a security token that "doesn\'t expire and is unique for each configuration". Copy it then.',
    fireTest:
      "Neither mechanism documents a test-send facility, so the first real action is the test. For an Outgoing Webhook, post a message in a public channel of that team @mentioning the webhook by name. For Microsoft Graph change notifications, the subscription request itself makes Graph POST a validationToken query to your notification URL, so the URL sees traffic before any Teams message exists.",
    eventsIntro:
      "Outgoing Webhooks have no event vocabulary at all — nothing to select, nothing to subscribe to. The identifiers below belong to Microsoft Graph change notifications: lowercase past-tense changeType verbs, comma-joined on a subscription, plus lifecycleEvent values delivered to a separate lifecycleNotificationUrl. Graph documents deleted only for chat-message subscriptions.",
    eventExamples: [
      "created",
      "updated",
      "deleted",
      "reauthorizationRequired",
      "subscriptionRemoved",
    ],
    gotchas: [
      {
        heading: "Five seconds, and it's a reply",
        body: "The how-to page gives your code five seconds to respond before the connection times out and terminates. The older webhooks-and-connectors overview says ten for the same behaviour, so the official docs disagree with themselves — build against five. Your response body appears in the same reply chain as the original message, which makes it user-visible copy, not an internal acknowledgement.",
      },
      {
        heading: "Validate the HMAC on every request",
        body: "Each request carries an authorization header of the form HMAC followed by a base64 value. Compute a standard SHA256 HMAC over the UTF-8 byte array of the raw body, keyed with the base64-decoded security token from registration, and compare. The docs say your code must always validate it. Teams only makes the webhook available if the URL is valid and the server and client tokens are equal.",
      },
      {
        heading: "Scoped to one team, public channels only",
        body: "Outgoing Webhooks are configured per team and visible to all that team's members, and they cannot be included as part of a normal Teams app. Users can only message one in public channels, not in personal or private scope. A webhook registered in one team does not exist anywhere else, so exercise it where you created it.",
      },
      {
        heading: "Graph validates the URL before subscribing",
        body: "Creating a Microsoft Graph change-notification subscription first POSTs to your notification URL with a validationToken query parameter. You have ten seconds to reply with 200 OK, content type text/plain, and the URL-decoded token as plain text in the body. Return it still encoded and validation fails; fail validation and Graph doesn't create the subscription. The endpoint must be publicly accessible over HTTPS.",
      },
      {
        heading: "Graph marks slow endpoints, then drops",
        body: "Graph counts a notification delivered only on a 2xx received within three seconds, then retries at exponential-backoff intervals for up to four hours with the per-attempt timeout extended to ten seconds. Blow the three-second allowance on more than 10% of responses in a ten-minute window and the endpoint is marked slow; blow the ten-second one on more than 15% and notifications are dropped. Microsoft suggests queueing and returning 202 Accepted.",
      },
      {
        heading: "Outgoing Webhook retries are undocumented",
        body: "The how-to page describes the synchronous request and response and nothing else: no retry policy, no schedule, no success status code, no payload size cap, no ordering statement. Don't carry the Graph numbers across — they belong to a different product. Until Microsoft documents otherwise, treat a timed-out delivery as a message you will not see again.",
      },
    ],
    faq: [
      {
        question: "Does Microsoft Teams have a test-send button for webhooks?",
        answer:
          "No test facility is documented for either Outgoing Webhooks or Microsoft Graph change notifications. You fire an Outgoing Webhook by @mentioning it by name in a public channel. A Graph subscription request sends a validation POST to your notification URL, which at least proves the URL is reachable.",
      },
      {
        question: "Why does my Microsoft Teams Outgoing Webhook never fire?",
        answer:
          "Check the three conditions the docs are explicit about: someone must @mention the webhook by name, the message must be in a public channel, and the webhook only exists inside the team it was created in. Personal and private scope are not supported.",
      },
      {
        question: "How do I verify a Microsoft Teams Outgoing Webhook signature?",
        answer:
          "Teams sends an HMAC value in the authorization header. Base64-decode the security token issued at registration, compute a standard SHA256 HMAC over the raw request body as a UTF-8 byte array, base64-encode the result, and compare. The docs say your code must always validate it.",
      },
      {
        question: "Does Microsoft Teams retry a failed Outgoing Webhook delivery?",
        answer:
          "The documentation does not say. It describes only a synchronous request with a five-second response window, and states no retry policy, schedule, or success status code. The retry and throttling figures published for Microsoft Graph change notifications belong to a different mechanism and do not apply here.",
      },
      {
        question: "What events can I subscribe to in Microsoft Teams?",
        answer:
          "Outgoing Webhooks have no event vocabulary — there is nothing to select. Names live in Microsoft Graph change notifications: changeType values such as created and updated, with deleted documented for chat messages, plus the lifecycle events reauthorizationRequired and subscriptionRemoved.",
      },
    ],
  },
  {
    slug: "airtable",
    name: "Airtable",
    title: "Test Airtable webhook pings locally",
    description:
      "Airtable's webhook POST is a ping with no data in it. Here's what that changes when you wire the flow up on your own machine.",
    h1: "Test Airtable webhooks locally",
    lede: "Airtable webhooks are registered through the Web API — that is the only path Airtable's docs describe — and the POST that lands on your endpoint carries no data. Both facts change how you test one.",
    distinctive:
      "The notification body is three fields — base id, webhook id, timestamp — and nothing else. Per Airtable's docs, the recipient is then responsible for requesting the contents of the updates from the API. So what you're testing locally isn't a payload shape, it's a fetch loop: take the ping, call list webhook payloads with a cursor (omit it the first time and it defaults to 1), and keep calling while mightHaveMore is true, at most 50 payloads per request. Delivery is at-least-once and coalesced, so pings and changes don't reliably line up one to one.",
    configure:
      "Airtable's docs describe only the API path for this. You POST to the bases webhooks endpoint on api.airtable.com with a notificationUrl and a specification object, using a personal access token or OAuth token, and creator-level permissions are required to register at all. Scopes stack: webhook:manage always, plus data.records:read if the specification subscribes to tableData, and schema.bases:read for tableFields or tableMetadata. The 200 response hands back the webhook id and macSecretBase64.",
    fireTest:
      "No send-test button, no sample generator. The whole surface is six endpoints — create, list, delete, enable or disable notification pings, list payloads, and refresh — and none of them manufactures traffic. You provoke the first ping by making a change in the base that actually matches your specification, such as editing a record in the scoped table. Then read lastNotificationResult from the webhooks list: success, retryNumber, error, willBeRetried, alongside lastSuccessfulNotificationTime.",
    eventsIntro:
      "Nothing here is dotted or slashed. A subscription is a cross-product of flat camelCase enums inside specification.options.filters: dataTypes picks which kind of data to watch, changeTypes narrows to additions, removals or updates, and fromSources plus a recordChangeScope table or view id narrow it further.",
    eventExamples: ["tableData", "tableFields", "tableMetadata", "add", "remove", "update"],
    gotchas: [
      {
        heading: "Twenty-five seconds, then thirteen retries",
        body: "Your endpoint has to return 200 or 204 with an empty response body, and the connection, request and response together must finish inside 25 seconds. Miss that and Airtable retries the ping up to 13 times with exponential backoff starting at 10 seconds — roughly a day — then drops the ping and disables notifications for that webhook.",
      },
      {
        heading: "Nothing turns notifications back on for you",
        body: "Disabling notifications does not stop payload generation, so the changes keep accumulating and you can catch up once the endpoint is fixed. The pings, though, stay off until you POST enable set to true to that webhook's enableNotifications endpoint. Worth knowing before you spend an afternoon wondering why a repaired handler is silent.",
      },
      {
        heading: "The webhook expires after seven days",
        body: "A webhook created with a personal access token or OAuth token expires and is disabled after 7 days. Calling refresh webhook or list webhook payloads extends it another 7 days, so an active fetch loop keeps itself alive while an idle test setup quietly does not. Payloads are deleted after a week whether or not you have read them.",
      },
      {
        heading: "One ping is not one change",
        body: "Pings are at-least-once, spurious notifications with no new changes are possible, and multiple changes in rapid succession may produce only a single notification. Deduplicate and order on baseTransactionNumber, which is scoped to that webhook and increases sequentially, rather than counting pings or trusting arrival order.",
      },
      {
        heading: "The MAC secret is shown once",
        body: "Each ping carries an X-Airtable-Content-MAC header, a hash of the body contents using the hook's MAC secret. That secret comes back only in the create response, as macSecretBase64, and the docs say plainly there is no way to retrieve it after initial creation. Store it before you close the terminal.",
      },
      {
        heading: "Ten webhooks per base is the ceiling",
        body: "A base allows 10 webhooks, and a single OAuth integration is limited to 2 per base. All of it sits under the same 5 requests per second per base limit as the rest of the API, which is worth remembering when a ping handler immediately turns around and calls list webhook payloads.",
      },
    ],
    faq: [
      {
        question: "Can I point an Airtable webhook at localhost?",
        answer:
          "Airtable delivers the ping from its own infrastructure to whatever notificationUrl you registered. Register a URL that forwards to your machine and point the webhook at that. Airtable's docs state no further requirements for the URL.",
      },
      {
        question: "Does Airtable have a button that sends a test webhook?",
        answer:
          "No. The Webhooks API is six endpoints: create, list, delete, enable or disable notification pings, list payloads, and refresh. None of them fires a sample. Make a change in the base that matches your specification and the ping follows from that.",
      },
      {
        question: "Why is my Airtable webhook payload empty?",
        answer:
          "It is not broken. The notification body is only the base id, the webhook id and a timestamp. The changes themselves come from a separate call to list webhook payloads, which returns a maximum of 50 per request, so keep paging while mightHaveMore is true.",
      },
      {
        question: "Which token scopes does an Airtable webhook need?",
        answer:
          "The scope webhook:manage is required for every webhooks endpoint. Beyond that, a specification subscribing to tableData also needs data.records:read, and one subscribing to tableFields or tableMetadata needs schema.bases:read. Registering a webhook additionally requires creator level permissions on the base.",
      },
      {
        question: "Can I scope an Airtable webhook to a single table?",
        answer:
          "Yes. recordChangeScope takes a table or view id and only generates payloads for changes in it, though Form and List views are not supported as a scope. It pairs with fromSources, which filters by origin: client, publicApi, formSubmission, automation, sync and several others.",
      },
      {
        question: "What happens to Airtable changes I miss while testing?",
        answer:
          "Payloads keep being generated even when notifications are disabled, and you read them back with the cursor, so a broken endpoint does not lose the changes outright. The limit is time: payloads are deleted from Airtable's servers after 1 week whether or not you have seen them.",
      },
    ],
  },
  {
    slug: "notion",
    name: "Notion",
    title: "Test Notion webhooks locally without deploying",
    description:
      "Notion won't deliver to localhost and has no test-send button. Catch the verification token handshake, inspect real events, replay them locally.",
    h1: "Test Notion webhooks locally",
    lede: "Notion's webhooks open with a handshake, not an event: nothing is delivered until you read a one-time verification token off a live request and paste it back into the dashboard. The docs are also blunt that localhost won't do.",
    distinctive:
      "Nearly all the friction with Notion is front-loaded. A subscription does not start delivering when you save it. Notion immediately POSTs a one-time body containing a verification_token to the URL you entered, and you have to read that value out of the request and paste it back into the Webhooks tab before a single event flows. The same token then doubles as the HMAC-SHA256 key for the X-Notion-Signature header on every later delivery. Which means you need a reachable, inspectable URL before you have anything worth inspecting.",
    configure:
      'Open your connection settings at app.notion.com/developers/connections, create or pick a connection, then go to the Webhooks tab and click "+ Create a subscription". Enter the public webhook URL, choose the event types you want, and click "Create subscription". The subscription exists at that point but is not yet verified: catch the verification_token Notion posts to it, paste the value into the form, and click "Verify subscription".',
    fireTest:
      "There is no test-send affordance anywhere in Notion's webhook reference. The only thing the dashboard will re-fire is the one-time verification token, via \"Resend token\". Notion's own testing section tells you to go and do the thing: change a page title, add a comment, modify a database schema. For quick feedback the docs suggest starting with non-aggregated events like comment.created or page.locked.",
    eventsIntro:
      "Event types are dot-separated and usually read entity.action — entity being page, database, data_source, comment, file_upload or view, and action in snake_case. Usually, not always: page.transcription_block.transcript_deleted carries three segments. The data_source family arrived with the 2025-09-03 API version, which also deprecated database.content_updated and database.schema_updated.",
    eventExamples: [
      "page.created",
      "page.content_updated",
      "page.properties_updated",
      "comment.created",
      "data_source.schema_updated",
      "page.deleted",
    ],
    gotchas: [
      {
        heading: "The verification token is also the signing key",
        body: "Notion sends verification_token exactly once, in the body of the POST that lands the moment you create the subscription. Pasting it back into the Webhooks tab is what turns delivery on — but keep the value afterwards. X-Notion-Signature on every subsequent request is an HMAC-SHA256 of the request body keyed with that token, hex-encoded and prefixed with sha256=.",
      },
      {
        heading: "Localhost is not an option",
        body: 'Notion requires "a secure (SSL) and publicly available endpoint" and states plainly that "Endpoints in localhost are not reachable". There is no development exception. Whatever URL you register has to answer from the public internet, first for the verification POST and then for every event that follows it.',
      },
      {
        heading: "The URL is frozen after verification",
        body: "You can change a subscription's webhook URL only before it is verified. Afterwards, repointing it means deleting the subscription and creating a new one, which means a fresh verification token and fresh plumbing on your side. Subscribed event types, by contrast, can be changed at any time.",
      },
      {
        heading: "Events are signals, not content",
        body: "Notion is explicit that the events do not contain the full content that changed. The payload tells you which entity moved and when; retrieving what it now says is a follow-up call to the Notion API. Common fields include type, entity, data, id, timestamp, workspace_id, workspace_name, subscription_id, integration_id, authors, attempt_number and api_version.",
      },
      {
        heading: "Aggregation can swallow your test",
        body: "High-frequency events such as page.content_updated are aggregated per entity, adding a delay Notion describes as typically under one minute. Events in quick succession may collapse into only the most meaningful result event — or none at all, if the state ends up back where it started. Order is not preserved either; reorder on the event's timestamp field.",
      },
      {
        heading: "At-most-once delivery, then inactivation",
        body: "Notion aims for at-most-once delivery and retries up to 8 times on an exponential backoff, the final attempt landing roughly 24 hours after the event; attempt_number on each delivery runs 1 to 8. Repeated failures can inactivate a subscription outright — the compliance audit log documents both a failing and a restored event for exactly that.",
      },
    ],
    faq: [
      {
        question: "Does Notion have a test webhook button?",
        answer:
          "No test-send affordance appears anywhere in Notion's webhook documentation. The only thing the dashboard will re-fire is the one-time verification token, via Resend token. To produce a real event you perform a real action in the workspace, such as adding a comment or renaming a page.",
      },
      {
        question: "Why is my Notion webhook subscription not delivering anything?",
        answer:
          "A new subscription stays pending verification until you paste the verification token back into the Webhooks tab and confirm. Until then Notion sends nothing beyond that single handshake request. Later on, repeated delivery failures can inactivate a working subscription as well.",
      },
      {
        question: "Can I point a Notion webhook at localhost?",
        answer:
          "No. Notion requires a secure, publicly available endpoint and says outright that endpoints in localhost are not reachable. You need a public HTTPS URL that Notion can reach, both for the initial verification request and for every event after it.",
      },
      {
        question: "How does Notion sign its webhook requests?",
        answer:
          "Every request carries an X-Notion-Signature header: an HMAC-SHA256 of the request body, keyed with the verification token from the initial handshake, hex-encoded and prefixed with sha256 followed by an equals sign. Save the token when you verify, because it is the only way to check signatures.",
      },
      {
        question: "Can I create a Notion webhook subscription through the API?",
        answer:
          "Notion documents subscription management only through the connection settings UI, and no webhook subscription endpoints appear in its API reference. Plan on creating, verifying and deleting subscriptions by hand in the Webhooks tab, including whenever you need to repoint a URL.",
      },
      {
        question: "How quickly does Notion deliver a webhook event?",
        answer:
          "Notion says events should be delivered within five minutes of occurring, and most within a minute. Aggregated event types add a further delay the docs describe as typically under one minute, which is why the troubleshooting advice favours non-aggregated types when testing.",
      },
    ],
  },
  {
    slug: "zoom",
    name: "Zoom",
    title: "How to test Zoom webhooks locally",
    description:
      "Zoom validates your endpoint before it will save a subscription, never retries a 4xx, and documents no send-test-event control. Here's what that means locally.",
    h1: "Test Zoom webhooks locally",
    lede: "Zoom's webhook setup has a gate in it: your endpoint has to answer a challenge-response check before Zoom will let you save the subscription at all — and it re-runs that check every 72 hours.",
    distinctive:
      "Zoom won't let you save an event subscription until your URL answers a challenge. Click Validate and Zoom POSTs an endpoint.url_validation event carrying a plainToken; you have three seconds to return 200 or 204 with a JSON body echoing that plainToken plus encryptedToken, an HMAC SHA-256 of it salted with your webhook secret token, output in hex. A 200 on its own doesn't pass. And it isn't a one-time hurdle: Zoom re-runs the check every 72 hours, emails you after two and after four consecutive failures, and disables the subscription after six in a row.",
    configure:
      "In the Zoom App Marketplace, click Manage, open your app from Created Apps, and go to Features then Access. Under General Features, enable Event Subscriptions and add a new subscription. Choose your event types, paste the capture URL into the Event notification endpoint URL field, and click Validate — Zoom refuses to save the subscription until validation succeeds. Then Save.",
    fireTest:
      "Zoom's docs describe no send-test-event control. The only request Zoom fires on demand is the Validate button, which sends endpoint.url_validation and nothing else. Everything past that means performing the real action in Zoom — scheduling or starting a meeting — and letting the subscription fire on its own. To confirm what Zoom actually sent, the Get webhook logs API returns webhook call logs from the past seven days.",
    eventsIntro:
      "Almost every Zoom event is dot-separated resource.action — lowercase resource, snake_case action. The exception worth knowing is app_deauthorized, which carries no resource prefix and is delivered to a separate Deauthorization Notification Endpoint URL rather than to your event subscription.",
    eventExamples: [
      "meeting.created",
      "meeting.started",
      "meeting.participant_joined",
      "meeting.ended",
      "recording.completed",
      "endpoint.url_validation",
    ],
    gotchas: [
      {
        heading: "Three seconds, then it's a failure",
        body: "Zoom counts a notification delivered only if your endpoint returns 200 or 204 within three seconds of the request. Anything slower is a failed delivery, regardless of what your handler eventually did with the payload. Acknowledge first and process afterwards — everything you do before responding is inside that budget.",
      },
      {
        heading: "A 4xx is never retried",
        body: "Zoom retries three times: five minutes after the initial delivery attempt, twenty minutes after that retry, then sixty after the second. But only for responses of 500 and above, plus a set of Zoom-internal negative codes. Redirects and 4xx responses get no retry at all, and after three failures Zoom sends no further webhooks for that event.",
      },
      {
        heading: "No replay, a seven-day log",
        body: "Nothing in Zoom's docs offers a redeliver control, so an event that burns through its three retries is gone. What you do get is the Get webhook logs API, which returns webhook call logs for an app from the past seven days — enough to see what was sent, not enough to send it again.",
      },
      {
        heading: "Verify signatures, don't allowlist IPs",
        body: "Zoom signs each request with x-zm-signature, formed as v0= followed by an HMAC over the string v0:timestamp:body, where the timestamp comes from x-zm-request-timestamp. Zoom publishes its IP ranges in a support article but recommends signature verification instead, because those ranges can change at any time.",
      },
      {
        heading: "Twenty subscriptions, and duplicates",
        body: "An app can hold up to twenty event subscriptions, and Zoom notes that subscriptions can carry duplicate events — the same event type selected in two of them means one action produces more than one POST. The endpoint itself must be a publicly reachable HTTPS FQDN on TLS 1.2 or later with a CA-issued certificate chain.",
      },
    ],
    faq: [
      {
        question: "Can I send a test Zoom webhook without starting a meeting?",
        answer:
          "Only the validation request. Clicking Validate makes Zoom POST its URL validation challenge to your endpoint, and Zoom's docs describe no other on-demand send. For a meeting or recording event you have to perform the real action in Zoom and let the subscription fire the way it normally would.",
      },
      {
        question: "Why won't Zoom let me save my event subscription?",
        answer:
          "Zoom blocks the save until the endpoint passes its challenge-response check. The URL has to answer the validation POST within three seconds with a 200 or 204 and a JSON body containing the plainToken it received plus encryptedToken, the hex HMAC SHA-256 of that token salted with your webhook secret token.",
      },
      {
        question: "Does Zoom stop sending webhooks if my endpoint goes down?",
        answer:
          "Yes, eventually. Validation re-runs every 72 hours; Zoom emails you after two consecutive failures and again after four, then disables the event subscription after six in a row. Individual events also stop after three failed delivery attempts.",
      },
      {
        question: "Can I replay a Zoom webhook my server missed?",
        answer:
          "Not from Zoom. No redeliver control appears in the docs, and a delivery that exhausts the three retries is not sent again. The Get webhook logs API shows what was sent in the past seven days, but reading a log is not the same as receiving the event again.",
      },
      {
        question: "Why isn't my Zoom app receiving deauthorization events?",
        answer:
          "Those don't go to your event notification endpoint at all. Zoom delivers them to a separate Deauthorization Notification Endpoint URL, and they only fire for publicly published apps — private apps and apps still in development do not trigger deauthorization notifications.",
      },
    ],
  },
  {
    slug: "calendly",
    name: "Calendly",
    title: "Test and debug Calendly webhooks locally",
    description:
      "Calendly webhooks are registered by API call, and there is no test send — here's what to know before pointing one at your machine.",
    h1: "Test Calendly webhooks locally",
    lede: "Calendly won't let you fake a delivery. Registration is an API call, you trigger a delivery by booking or cancelling something for real, and a single reschedule arrives as two separate webhooks.",
    distinctive:
      "Calendly documents webhook creation only through the API — the help centre's entire create-a-webhook step is to follow the steps in the Developer Portal. Registration happens by POSTing to the webhook subscriptions endpoint on api.calendly.com with a personal access token. The field that catches people is organization: it's required on every create call, including user and group scopes, so a user-scoped subscription still needs the org URI alongside the user one. And there's nothing to press afterwards. Calendly's instruction is to trigger a new event — a booking, a cancellation, a reschedule — and it notes webhooks are not triggered by past events.",
    configure:
      "POST to https://api.calendly.com/webhook_subscriptions with url, events, organization and scope in the body — those four are required — plus user or group when you're scoping that narrowly. Authenticate with a personal access token or an OAuth token. For a personal access token: log in, go to the Integrations page, select the API & Webhooks tile, generate a token. One scope caveat: routing_form_submission.created accepts organization only. Re-registering a URL that already has a subscription comes back as a 409.",
    fireTest:
      "There's no sample-send control, no test event, no CLI. Calendly's own instruction is the whole story: \"To test your webhook, trigger a new event (such as a booking, cancellation, or reschedule). Webhooks are not triggered by past events.\" So you book a slot on your own scheduling link, then cancel it — which, conveniently, exercises two of the events you probably care about.",
    eventsIntro:
      "The vocabulary is resource.action, with the resource in snake_case and the action a past-tense verb. Watch the American single-l spelling in invitee.canceled. The verbs don't combine freely either — there's contact.updated but no invitee.updated. Take the list from the enum on the create-subscription reference, not the prose table above it.",
    eventExamples: [
      "invitee.created",
      "invitee.canceled",
      "invitee_no_show.created",
      "invitee_no_show.deleted",
      "routing_form_submission.created",
      "contact.created",
    ],
    gotchas: [
      {
        heading: "A reschedule fires two webhooks",
        body: "Reschedule isn't an event of its own. Calendly triggers invitee.canceled for the old booking, carrying rescheduled set to true, and invitee.created for the new one. Count naively and you record a cancellation plus an unrelated booking. The old_invitee and new_invitee URIs sit on the invitee model, not the event model — that's what links the pair.",
      },
      {
        heading: "Answer inside fifteen seconds",
        body: "Delivery uses a 10-second connection timeout and a 15-second read timeout. Acknowledge first, then do the slow work in a background job. This bites hardest during local debugging: a breakpoint sitting in your handler is indistinguishable, from Calendly's side, from an endpoint that has stopped answering, and a connection timeout starts the retry process.",
      },
      {
        heading: "A failing endpoint gets disabled",
        body: "3xx, 4xx and 5xx responses are retried with exponential back-off for 24 hours, or until 24 hours after the booking of the event passes. After that the webhook is disabled if another message was not delivered successfully, and the subscription has to be recreated. Other messages keep being sent while one is failing.",
      },
      {
        heading: "The signature carries its own timestamp",
        body: "When a signing key is set, deliveries carry a Calendly-Webhook-Signature header with a t= timestamp and a v1= hex digest. You HMAC-SHA256 the timestamp, a literal dot, and the raw request body. The key is optional on personal-access-token subscriptions and generated automatically for OAuth 2.0 apps. Calendly's sample code rejects a t older than 180 seconds.",
      },
      {
        heading: "Watch the subscription's state field",
        body: "The subscription resource exposes state, active or disabled, plus retry_started_at. Polling Get Webhook Subscription is the practical way to spot a subscription that's partway through being retired, rather than discovering it when bookings quietly stop arriving. Worth wiring into a check while you still remember why it matters.",
      },
    ],
    faq: [
      {
        question: "Does Calendly have a test button for webhooks?",
        answer:
          "No. There is no sample send and no replay control. Calendly's guidance is to trigger a new event — a booking, a cancellation or a reschedule — and it notes that webhooks are not triggered by past events. Booking a slot on your own scheduling link is the test.",
      },
      {
        question: "Why does Calendly reject my user-scoped webhook subscription?",
        answer:
          "Most likely the organization URI is missing. It is required on every create call regardless of scope, because one user can belong to multiple organizations. For user scope you send both the organization and the user URI; for group scope, the organization and the group.",
      },
      {
        question: "Which Calendly plans can create webhook subscriptions?",
        answer:
          "A paid one, though Calendly's own pages differ on which. The help centre lists Standard, Professional, Teams and Enterprise. The developer FAQ lists Standard, Teams and Enterprise. Check both before assuming a given plan qualifies.",
      },
      {
        question: "What status code should my endpoint return to Calendly?",
        answer:
          "2xx. A Calendly employee answering on the company's community forum says non-2xx responses, or a connection timeout, start the retry process. The API docs only state the negative — that 3xx, 4xx and 5xx responses trigger retries — so no official page names an expected code.",
      },
      {
        question: "Does Calendly verify my endpoint when I register it?",
        answer:
          "Nothing in the API spec or the help centre describes a challenge request or a verification ping at subscription time. The one thing the create call does check is uniqueness: registering a URL that already has a subscription returns a 409 saying a hook with this url already exists.",
      },
      {
        question: "How is the Calendly cancellation event spelled?",
        answer:
          "One l. The accepted value is invitee.canceled, American spelling. The double-l form does not appear in the list of event names the create-subscription call accepts, so copy the string rather than typing it from memory.",
      },
    ],
  },
  {
    slug: "zendesk",
    name: "Zendesk",
    title: "How to test Zendesk webhooks locally",
    description:
      "Zendesk's create flow, its built-in Test webhook panel, the zen:event-type: naming, and the retry and circuit-breaker rules that bite during development.",
    h1: "Test Zendesk webhooks locally",
    lede: "Zendesk will happily send you real ticket events, but it also ships a Test webhook panel that fires a sample request on demand. Here's what's specific to Zendesk once your local endpoint is listening.",
    distinctive:
      "Zendesk creates the webhook as a standalone object, and the first thing the create flow asks is the connection method — Zendesk events, or Trigger or Automation. That choice decides everything after it. Pick Zendesk events and you select event types from a dropdown. Pick Trigger or Automation and the webhook is driven by a business rule instead, and its request payload or URL parameters can't exceed 16,000 characters. The names are URN-shaped rather than bare verbs, too: a fixed zen:event-type: prefix in front of every one.",
    configure:
      "In Admin Center, click Apps and integrations in the sidebar, then select Webhooks, then Webhooks, and click Create webhook. Choose the connection method — Zendesk events, or Trigger or Automation — and click Next. Then fill in a Name, a Description, and the Endpoint URL. HTTPS isn't required, but custom headers only work on a secure HTTPS endpoint, so paste the https form of your ingest URL.",
    fireTest:
      "Zendesk ships its own: find the webhook in the list, open the options menu on its row, and click Test webhook. Select an event to test — that's a sample request — fill in the request body, parameters or headers, and click Send test. The response shows in the panel below. The same button appears while you're creating or editing a webhook, and the API equivalent is POST /api/v2/webhooks/test.",
    eventsIntro:
      "Every event type is a URN: the fixed prefix zen:event-type: followed by a dot-separated resource and action pair. Copy them exactly — the prefix is part of the name, and Zendesk's own index page renders a few entries with a slash where the per-resource reference pages use a colon.",
    eventExamples: [
      "zen:event-type:ticket.created",
      "zen:event-type:ticket.comment_added",
      "zen:event-type:ticket.status_changed",
      "zen:event-type:ticket.priority_changed",
      "zen:event-type:user.created",
      "zen:event-type:organization.created",
    ],
    gotchas: [
      {
        heading: "Retries name only three codes",
        body: "The docs name only three retryable statuses. A 409 is retried up to three times; a 429 or 503 is retried only if the response carries a retry-after header valued at under 60 seconds. Requests that hit the timeout are retried up to five times. Consecutive failures won't deactivate the webhook, though.",
      },
      {
        heading: "Twelve seconds, and not adjustable",
        body: "Webhook requests have a 12-second timeout, and the timeout period is not adjustable. A slow receiver doesn't fail quietly — it lands in the activity log as Failed: 504 Gateway Timeout, which is Zendesk describing your endpoint rather than its own. Pausing a forwarded request on a breakpoint reproduces this quickly.",
      },
      {
        heading: "The circuit breaker cuts you off",
        body: "If 70% of a webhook's requests error inside a five-minute period, or it takes more than 1,000 error responses in five minutes, the circuit breaker fires and blocks sending for five seconds. Attempts during the pause are logged with a status of circuit broken until a request succeeds. It won't fire below 100 requests per five minutes.",
      },
      {
        heading: "Duplicates and ordering are yours",
        body: "Delivery is best effort: the same action can invoke a webhook more than once, and under some conditions — the circuit breaker firing, for one — an event may not be delivered at all. Make handlers idempotent. Because webhook jobs are queued and run independently, the order they execute in isn't promised.",
      },
      {
        heading: "Custom headers need HTTPS",
        body: "Secure HTTP is recommended rather than required for the endpoint URL, but custom headers only work on an HTTPS endpoint — so if you're testing header-based auth, an insecure URL won't get you there. Separately, a webhook connected to a trigger or automation caps its request payload or URL parameters at 16,000 characters.",
      },
    ],
    faq: [
      {
        question: "Can I test a Zendesk webhook without waiting for a real ticket event?",
        answer:
          "Yes. Admin Center has a Test webhook option on each webhook's row, and the same button appears while you create or edit one. You pick a sample event, fill in the request body, parameters or headers, send it, and read the response inline.",
      },
      {
        question: "Why did my Zendesk webhook fire twice for one ticket update?",
        answer:
          "Zendesk makes a best effort to deliver each action a single time, which means the same action can invoke a webhook multiple times. Build the handler to be idempotent, keyed on something stable in the payload, and treat a repeat as expected rather than as a bug.",
      },
      {
        question: "How long does Zendesk wait for my endpoint to respond?",
        answer:
          "Twelve seconds, and the timeout period is not adjustable. Anything slower is recorded in the activity log as Failed: 504 Gateway Timeout. Requests that time out are retried up to five times, which is a longer allowance than most error statuses get.",
      },
      {
        question: "Does Zendesk require an HTTPS endpoint URL?",
        answer:
          "No. Secure HTTP is recommended but not required for the endpoint URL. There is one catch worth knowing: custom headers only work when the endpoint URL is HTTPS, so an insecure URL quietly limits what you can configure on the webhook itself.",
      },
      {
        question: "How do I verify that a request really came from Zendesk?",
        answer:
          "Zendesk sends optional signature headers named X-Zendesk-Webhook-Signature and X-Zendesk-Webhook-Signature-Timestamp. The signature is the base64 encoding of an HMAC SHA256 over the timestamp concatenated with the body. Compute the same value with your signing secret and compare it before acting on the payload.",
      },
      {
        question: "What do Zendesk webhook event names look like?",
        answer:
          "Every event type is a URN with the fixed prefix zen:event-type: followed by a dot separated resource and action, such as zen:event-type:ticket.created. Copy the strings exactly from the per resource reference pages; the prefix is part of the name, not documentation shorthand.",
      },
    ],
  },
  {
    slug: "sendgrid",
    name: "SendGrid",
    title: "Test SendGrid event webhooks locally",
    description:
      "SendGrid's Event Webhook posts batched JSON arrays, not single events. Capture one, inspect what arrived, and replay it against your local handler.",
    h1: "Test SendGrid webhooks locally",
    lede: "SendGrid's Event Webhook reports delivery and engagement activity in batches. Here's what that means for the handler you're writing, and how to see a batch land on your laptop.",
    distinctive:
      "SendGrid's Event Webhook doesn't send one event per request. It batches: a POST fires within approximately 30 seconds, or as soon as the pending batch reaches 768 kilobytes, and the body is a JSON array of event objects. A handler written around a single top-level object breaks. Separately, duplicates are expected — the docs say the same event can appear more than once in the posted data, and name sg_event_id as the field to deduplicate on. Watching one real batch land locally settles both questions at once: how many events arrive together, and which of them you have already seen.",
    configure:
      "In the SendGrid app go to Settings > Mail Settings > Webhook Settings > Event Webhooks and click Create new webhook. Only two fields are required: the Post URL, which is where SendGrid sends the data, and Actions to be posted, which picks the event types. How many Event Webhooks an account gets depends on the SendGrid plan, and downgrading disables the newest ones automatically.",
    fireTest:
      "There is a test facility, and it's a button. Test Your Integration, on the Event Webhook settings screen, sends an HTTP POST to your configured Post URL containing a JSON array of example events. The same thing is exposed over the API as POST /v3/user/webhooks/event/test, which answers 204 No Content. The payload is made up of example events and will not include real data from your mail send.",
    eventsIntro:
      "The event field holds a single bare lowercase token — no resource prefix, no dot, no colon. Multi-word names are inconsistent rather than systematic: group_unsubscribe takes an underscore, spamreport runs together without one. Pattern-matching your way to a name will fail here, so copy the strings as written.",
    eventExamples: ["processed", "delivered", "bounce", "dropped", "open", "click"],
    gotchas: [
      {
        heading: "Duplicates are expected, not a bug",
        body: "SendGrid's docs state outright that it's possible to see duplicate events in the data posted by the Event Webhook, and recommend deduplicating on sg_event_id. Size that column generously: the overview page calls it a string up to 100 characters, while the event reference says these URL-safe IDs can exceed 100 characters. The two pages disagree, so don't pin a tight limit to either.",
      },
      {
        heading: "A non-2xx starts a 24-hour clock",
        body: "Anything other than a 2xx response makes SendGrid retry the POST at increasing intervals for up to 24 hours after the event occurred. That window is rolling, so each newly failing event gets its own 24-hour retry period. The interval schedule itself isn't published, so don't build timing assumptions on top of it.",
      },
      {
        heading: "Don't allowlist SendGrid's IPs",
        body: "The docs ask you not to block the addresses posting to your server, because their IPs often change as more machines are added, and no fixed range is published. If you want to receive encrypted posts, the callback URL must support TLS 1.2 — that's written as a condition, not as a blanket HTTPS requirement.",
      },
      {
        heading: "The signature headers say Twilio",
        body: "Verification is ECDSA over two headers named X-Twilio-Email-Event-Webhook-Signature and X-Twilio-Email-Event-Webhook-Timestamp. If you're grepping request logs for a header with SendGrid in the name, you'll come up empty. The docs describe the headers and the scheme but state no acceptable clock skew, so any replay window you enforce is a number you chose.",
      },
    ],
    faq: [
      {
        question: "Does SendGrid send one webhook request per event?",
        answer:
          "No. The Event Webhook batches events and posts them as a JSON array. A request fires within approximately 30 seconds, or sooner if the pending batch reaches 768 kilobytes, so one request can carry many events.",
      },
      {
        question: "How do I fire a test SendGrid webhook?",
        answer:
          "The Event Webhook settings screen has a Test Your Integration button that posts a JSON array of example events to your Post URL. The same test is available over the API as POST /v3/user/webhooks/event/test, which returns 204 No Content on success.",
      },
      {
        question: "Why does SendGrid send the same event twice?",
        answer:
          "Duplicates are documented behavior. SendGrid says it is possible to see duplicate events in the data posted by the Event Webhook, and recommends deduplicating with sg_event_id as the differentiator. Store that ID and treat a repeat as already handled.",
      },
      {
        question: "What happens if my server is down when SendGrid posts an event?",
        answer:
          "SendGrid retries the request until it receives a 2xx response or the maximum time has elapsed. Retries run at increasing intervals for up to 24 hours after the event occurs, and that window is rolling, so each newly failing event gets its own 24 hours.",
      },
      {
        question: "Are SendGrid Event Webhook payloads signed?",
        answer:
          "SendGrid documents ECDSA verification using a signature header and a timestamp header, both prefixed X-Twilio-Email-Event-Webhook. The docs give no acceptable timestamp tolerance, so if you reject old requests as replays, that threshold is one you pick rather than one SendGrid publishes.",
      },
    ],
  },
];

export function getTutorial(slug: string): Tutorial | undefined {
  return TUTORIALS.find((t) => t.slug === slug);
}

/** Site-absolute path for a tutorial. Single source of truth for the route manifest and the pages. */
export function tutorialPath(slug: string): string {
  return `/test/${slug}`;
}

/** How many siblings each tutorial links to. Also, therefore, the inbound count each one receives. */
export const RELATED_COUNT = 5;

/**
 * The siblings a tutorial links to: a wrapping window of the {@link RELATED_COUNT} entries that
 * follow it in {@link TUTORIALS}.
 *
 * The choice of a fixed window over anything content-aware is deliberate. Any scheme that ranks
 * siblings by similarity, popularity, or alphabet concentrates links on a favoured few and leaves the
 * tail with zero inbound links — which is precisely the orphaning this lane exists to fix, reproduced
 * one level down. A rotation makes the link graph a regular cycle, so every page gives exactly
 * `RELATED_COUNT` and receives exactly `RELATED_COUNT`, by construction rather than by review.
 * `tutorials.test.ts` measures that distribution rather than trusting this comment.
 *
 * An unknown slug (the shared component is rendered with a fixture in tests) yields the first window
 * instead of throwing — a tutorial page must never fail to render over a related-links strip.
 */
export function relatedTutorials(slug: string): readonly Tutorial[] {
  const start = TUTORIALS.findIndex((t) => t.slug === slug);
  const from = start === -1 ? -1 : start;
  return Array.from(
    { length: Math.min(RELATED_COUNT, Math.max(TUTORIALS.length - (start === -1 ? 0 : 1), 0)) },
    (_, i) => TUTORIALS[(from + 1 + i) % TUTORIALS.length]!,
  );
}

/**
 * The AUTHORED prose of a tutorial, as one string — what the near-duplicate guard compares.
 *
 * Deliberately excludes the shared "loop" copy and the CLI block that `TutorialPage` renders: those are
 * identical on every page by design, and feeding boilerplate to a similarity check only drags every
 * pair toward each other. What is left is exactly the writing that has to differ, so the score means
 * what we want it to mean.
 */
export function tutorialText(t: Tutorial): string {
  return [
    t.lede,
    t.distinctive,
    t.configure,
    t.fireTest,
    t.eventsIntro,
    ...t.gotchas.flatMap((g) => [g.heading, g.body]),
    ...t.faq.flatMap((f) => [f.question, f.answer]),
  ].join(" ");
}
