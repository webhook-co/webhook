/**
 * Provider display metadata — the single source for rendering a provider slug as a human name + brand
 * colour across the product (events list, filter dropdown) and marketing (the supported-providers wall).
 *
 * Keyed by the raw `provider` slug as a plain `string` (NOT the `Provider` type) so this stays a LEAF in
 * `@webhook-co/ui` — it must not pull `@webhook-co/shared`/`webhooks-spec` into the client bundle. The
 * mapping's COMPLETENESS against the registry's `PROVIDERS` tuple is proven by a test in apps/web (which
 * owns the shared dependency); an unknown/future slug degrades gracefully via `providerDisplayName`.
 *
 * `brandColor` is the provider's primary brand hex, used as the monogram-tile tint when no inline logo is
 * available (the logo set is layered on top of this metadata). Where a brand has no single canonical hex
 * (or is a spec, not a brand — Standard Webhooks), a recognisable, legible approximation is used.
 */

export interface ProviderBrand {
  readonly displayName: string;
  readonly brandColor: string;
}

export const PROVIDER_BRANDING: Record<string, ProviderBrand> = {
  stripe: { displayName: "Stripe", brandColor: "#635BFF" },
  github: { displayName: "GitHub", brandColor: "#181717" },
  shopify: { displayName: "Shopify", brandColor: "#5A863E" },
  slack: { displayName: "Slack", brandColor: "#4A154B" },
  standard_webhooks: { displayName: "Standard Webhooks", brandColor: "#4F46E5" },
  clerk: { displayName: "Clerk", brandColor: "#6C47FF" },
  resend: { displayName: "Resend", brandColor: "#000000" },
  stytch: { displayName: "Stytch", brandColor: "#19303D" },
  supabase: { displayName: "Supabase", brandColor: "#3FCF8E" },
  render: { displayName: "Render", brandColor: "#5468FF" },
  brex: { displayName: "Brex", brandColor: "#F46A35" },
  // S8 coverage — Standard Webhooks adopters (2026-07-01).
  openai: { displayName: "OpenAI", brandColor: "#10A37F" },
  replicate: { displayName: "Replicate", brandColor: "#000000" },
  polar: { displayName: "Polar", brandColor: "#0062FF" },
  gemini: { displayName: "Google Gemini", brandColor: "#4285F4" },
  incident_io: { displayName: "incident.io", brandColor: "#F25533" },
  etsy: { displayName: "Etsy", brandColor: "#F1641E" },
  vanta: { displayName: "Vanta", brandColor: "#5C4EE5" },
  // S8 coverage PR2 — raw-body HMAC providers (2026-07-01).
  pusher: { displayName: "Pusher", brandColor: "#300D4F" },
  quickbooks: { displayName: "QuickBooks", brandColor: "#2CA01C" },
  chargify: { displayName: "Maxio", brandColor: "#0A2540" },
  launchdarkly: { displayName: "LaunchDarkly", brandColor: "#3DD6F5" },
  modern_treasury: { displayName: "Modern Treasury", brandColor: "#1A1A1A" },
  autodesk_aps: { displayName: "Autodesk Platform Services", brandColor: "#000000" },
  mongodb_atlas: { displayName: "MongoDB Atlas", brandColor: "#00ED64" },
  // S8 coverage PR3 — Bucket B quirk-HMAC providers (2026-07-01).
  xero: { displayName: "Xero", brandColor: "#13B5EA" },
  segment: { displayName: "Segment", brandColor: "#52BD94" },
  aftership: { displayName: "AfterShip", brandColor: "#A24BFF" },
  onfleet: { displayName: "Onfleet", brandColor: "#0A1F44" },
  webflow: { displayName: "Webflow", brandColor: "#146EF5" },
  klaviyo: { displayName: "Klaviyo", brandColor: "#232426" },
  mux: { displayName: "Mux", brandColor: "#FB2491" },
  shippo: { displayName: "Shippo", brandColor: "#7B61FF" },
  buildkite: { displayName: "Buildkite", brandColor: "#14CC80" },
  // S8 coverage PR4 — more Bucket B quirk-HMAC providers (2026-07-01).
  ms_teams: { displayName: "Microsoft Teams", brandColor: "#6264A7" },
  ably: { displayName: "Ably", brandColor: "#FF5416" },
  squarespace: { displayName: "Squarespace", brandColor: "#000000" },
  nylas: { displayName: "Nylas", brandColor: "#5D5FEF" },
  linkedin: { displayName: "LinkedIn", brandColor: "#0A66C2" },
  tiktok: { displayName: "TikTok", brandColor: "#000000" },
  airship: { displayName: "Airship", brandColor: "#EF4A24" },
  lob: { displayName: "Lob", brandColor: "#0099D7" },
  persona: { displayName: "Persona", brandColor: "#4F46E5" },
  // S8 coverage PR5 — payment/fintech HMAC providers (2026-07-01).
  bolt: { displayName: "Bolt", brandColor: "#0011FF" },
  primer: { displayName: "Primer", brandColor: "#0A0A23" },
  airwallex: { displayName: "Airwallex", brandColor: "#612FFF" },
  affirm: { displayName: "Affirm", brandColor: "#4A4AF4" },
  // S8 coverage PR6/PR7 — bespoke asymmetric.
  keygen: { displayName: "Keygen", brandColor: "#5A50E0" },
  constant_contact: { displayName: "Constant Contact", brandColor: "#1985E1" },
  razorpay: { displayName: "Razorpay", brandColor: "#3395FF" },
  sentry: { displayName: "Sentry", brandColor: "#362D59" },
  linear: { displayName: "Linear", brandColor: "#5E6AD2" },
  dropbox: { displayName: "Dropbox", brandColor: "#0061FF" },
  checkout_com: { displayName: "Checkout.com", brandColor: "#0B0B0B" },
  lemon_squeezy: { displayName: "Lemon Squeezy", brandColor: "#FFC233" },
  coinbase_commerce: { displayName: "Coinbase Commerce", brandColor: "#0052FF" },
  dwolla: { displayName: "Dwolla", brandColor: "#F37F30" },
  gocardless: { displayName: "GoCardless", brandColor: "#1C1C1C" },
  notion: { displayName: "Notion", brandColor: "#000000" },
  meta: { displayName: "Meta", brandColor: "#0064E0" },
  woocommerce: { displayName: "WooCommerce", brandColor: "#96588A" },
  bitbucket: { displayName: "Bitbucket", brandColor: "#0052CC" },
  atlassian_jira: { displayName: "Jira", brandColor: "#0052CC" },
  x: { displayName: "X", brandColor: "#000000" },
  clickup: { displayName: "ClickUp", brandColor: "#7B68EE" },
  npm: { displayName: "npm", brandColor: "#CB3837" },
  heroku: { displayName: "Heroku", brandColor: "#430098" },
  dub: { displayName: "Dub", brandColor: "#000000" },
  cal_com: { displayName: "Cal.com", brandColor: "#292929" },
  asana: { displayName: "Asana", brandColor: "#F06A6A" },
  circleci: { displayName: "CircleCI", brandColor: "#343434" },
  pagerduty: { displayName: "PagerDuty", brandColor: "#06AC38" },
  airtable: { displayName: "Airtable", brandColor: "#18BFFF" },
  calendly: { displayName: "Calendly", brandColor: "#006BFF" },
  zoom: { displayName: "Zoom", brandColor: "#2D8CFF" },
  customerio: { displayName: "Customer.io", brandColor: "#5D38F6" },
  sinch: { displayName: "Sinch", brandColor: "#E6224A" },
  workos: { displayName: "WorkOS", brandColor: "#6363F1" },
  front: { displayName: "Front", brandColor: "#001B38" },
  zendesk: { displayName: "Zendesk", brandColor: "#03363D" },
  twitch: { displayName: "Twitch", brandColor: "#9146FF" },
  paddle: { displayName: "Paddle", brandColor: "#FDDD35" },
  recurly: { displayName: "Recurly", brandColor: "#A23F97" },
  docusign: { displayName: "DocuSign", brandColor: "#FBBA00" },
  vercel: { displayName: "Vercel", brandColor: "#000000" },
  intercom: { displayName: "Intercom", brandColor: "#1F8DED" },
  paystack: { displayName: "Paystack", brandColor: "#00C3F7" },
  authorize_net: { displayName: "Authorize.Net", brandColor: "#ED1C2E" },
  sanity: { displayName: "Sanity", brandColor: "#F03E2F" },
  square: { displayName: "Square", brandColor: "#000000" },
  trello: { displayName: "Trello", brandColor: "#0052CC" },
  twilio: { displayName: "Twilio", brandColor: "#F22F46" },
  mandrill: { displayName: "Mandrill", brandColor: "#E0457B" },
  hubspot: { displayName: "HubSpot", brandColor: "#FF7A59" },
  adyen: { displayName: "Adyen", brandColor: "#0ABF53" },
  mailgun: { displayName: "Mailgun", brandColor: "#C02021" },
  mercado_pago: { displayName: "Mercado Pago", brandColor: "#009EE3" },
  braintree: { displayName: "Braintree", brandColor: "#1B1B1B" },
  contentful: { displayName: "Contentful", brandColor: "#2478CC" },
  plivo: { displayName: "Plivo", brandColor: "#21C9D9" },
  typeform: { displayName: "Typeform", brandColor: "#262627" },
  messagebird: { displayName: "MessageBird", brandColor: "#2481D7" },
  netlify: { displayName: "Netlify", brandColor: "#00C7B7" },
  vonage: { displayName: "Vonage", brandColor: "#000000" },
  monday: { displayName: "monday.com", brandColor: "#FF3D57" },
  jira_connect: { displayName: "Jira Connect", brandColor: "#0052CC" },
  discord: { displayName: "Discord", brandColor: "#5865F2" },
  telnyx: { displayName: "Telnyx", brandColor: "#00C08B" },
  sendgrid: { displayName: "SendGrid", brandColor: "#1A82E2" },
  wise: { displayName: "Wise", brandColor: "#163300" },
  kinde: { displayName: "Kinde", brandColor: "#0E0E0E" },
  paypal: { displayName: "PayPal", brandColor: "#0070BA" },
  aws_sns: { displayName: "Amazon SNS", brandColor: "#E7157B" },
  plaid: { displayName: "Plaid", brandColor: "#000000" },
  gitlab: { displayName: "GitLab", brandColor: "#FC6D26" },
  microsoft_graph: { displayName: "Microsoft Graph", brandColor: "#0078D4" },
  chargebee: { displayName: "Chargebee", brandColor: "#FF6C37" },
  postmark: { displayName: "Postmark", brandColor: "#FFCC00" },
  sparkpost: { displayName: "SparkPost", brandColor: "#FA6423" },
  okta: { displayName: "Okta", brandColor: "#007DC1" },
  bigcommerce: { displayName: "BigCommerce", brandColor: "#121118" },
  datadog: { displayName: "Datadog", brandColor: "#632CA6" },
  brevo: { displayName: "Brevo", brandColor: "#0B996E" },
  ebay: { displayName: "eBay", brandColor: "#E53238" },
};

/** A neutral fill for an unknown/logo-less provider's monogram tile. */
export const FALLBACK_BRAND_COLOR = "#6B7280";

/** Title-case a raw slug as a last-resort display name (`mercado_pago` → "Mercado Pago"). */
function humanizeSlug(slug: string): string {
  return slug
    .split("_")
    .map((word) => (word.length === 0 ? word : word[0]!.toUpperCase() + word.slice(1)))
    .join(" ");
}

/**
 * The human display name for a provider slug. Falls back to a title-cased slug for an unknown/future
 * provider (forward-compatible: a new registry slug renders sensibly before its branding is authored).
 * `null` (an event with no detected provider) returns the caller-supplied placeholder.
 */
export function providerDisplayName(slug: string | null, fallbackForNull = "—"): string {
  if (slug === null) return fallbackForNull;
  return PROVIDER_BRANDING[slug]?.displayName ?? humanizeSlug(slug);
}

/** The brand colour for a provider slug (monogram-tile tint), or a neutral fallback. */
export function providerBrandColor(slug: string | null): string {
  if (slug === null) return FALLBACK_BRAND_COLOR;
  return PROVIDER_BRANDING[slug]?.brandColor ?? FALLBACK_BRAND_COLOR;
}
