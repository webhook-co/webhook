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
];

export function getTutorial(slug: string): Tutorial | undefined {
  return TUTORIALS.find((t) => t.slug === slug);
}

/** Site-absolute path for a tutorial. Single source of truth for the route manifest and the pages. */
export function tutorialPath(slug: string): string {
  return `/test/${slug}`;
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
