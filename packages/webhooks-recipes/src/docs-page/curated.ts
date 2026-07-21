// The ONLY hand-written content on a generated provider page: where the operator finds the credential.
//
// This cannot be derived from the registry — it lives in a provider's dashboard — so every entry cites
// the provider's OWN documentation, and `renderProviderPage` throws without that citation. Dashboard
// navigation drifts as providers redesign, which is exactly why each block stays one or two sentences
// and defers to the linked official page rather than reproducing a click-path we cannot keep current.
//
// Membership of this map IS the published set: the generator emits a page per key, so adding a
// provider means researching its docs first. The set is deliberately small. 62 providers have a
// distinct-enough recipe to avoid the dup-guard, but measured demand is 89% concentrated in the top
// ten (Discord alone is 71%), so generating the long tail would ship thin pages, not coverage.
//
// Excluded on purpose despite demand: calendly and zoom, whose recipes are byte-identical to Stripe's
// and Slack's. Rendering both through this template and comparing measures 0.95 Jaccard, well over the
// dup-guard's 0.8 line — so the moment Stripe or Slack is also generated, the pair fails the guard. The
// substantive point holds even today, when those two are still hand-written and the measured overlap is
// therefore low: a generated Calendly page would restate Stripe's scheme and teach nothing new. They
// earn narrative tutorial pages instead, which differentiate on something other than the recipe. Also
// excluded: gitlab/telegram/paypal/plaid — static-token or remote-fetch schemes with no recipe
// substantial enough to carry a reference page.

import type { CuratedSecret } from "./render";

export interface CuratedProvider extends CuratedSecret {
  /** Display name used in headings, prose, and the sidebar. */
  readonly displayName: string;
  /** Mintlify frontmatter icon — a brand slug where one exists, else a Font Awesome name. */
  readonly icon: string;
}

export const CURATED: Readonly<Record<string, CuratedProvider>> = {
  // Ed25519: the operator registers Discord's PUBLIC key, so this must never read "signing secret".
  discord: {
    displayName: "Discord",
    icon: "discord",
    credentialName: "public key",
    credentialKind: "public-key",
    where:
      "Your public key is shown on your application in the Discord Developer Portal — Discord generates it, you never supply one",
    sourceUrl: "https://docs.discord.com/developers/interactions/overview",
    note: "Discord validates an endpoint by deliberately sending invalid signatures, and expects a 401 back, so an endpoint that doesn't verify will fail registration",
  },
  // ECDSA: likewise a public verification key, not a shared secret.
  sendgrid: {
    displayName: "SendGrid",
    icon: "paper-plane",
    credentialName: "public verification key",
    credentialKind: "public-key",
    where:
      "In SendGrid, open Settings → Mail Settings → Webhook Settings → Event Webhooks, edit the webhook, and under Security features turn on Signed Event Webhook; reopening the dialog then shows the public verification key",
    sourceUrl:
      "https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features",
    note: "The key pair is generated only when you save, so signature verification can't be exercised before that",
  },
  zendesk: {
    displayName: "Zendesk",
    icon: "headset",
    credentialName: "signing secret key",
    credentialKind: "secret",
    where:
      "Open the webhook in Admin Center; its secret key is hidden until you choose Reveal secret",
    sourceUrl: "https://developer.zendesk.com/documentation/webhooks/verifying/",
    note: "Zendesk issues one per webhook, and only once the webhook is fully created — while you are still creating it, the value in play is a documented static test secret",
  },
  docusign: {
    displayName: "DocuSign",
    icon: "file-signature",
    credentialName: "secret key",
    credentialKind: "secret",
    where:
      "Go to Admin → Connect → the Connect Keys tab and choose Add Secret Key, then enable Include HMAC Signature on the Connect configuration itself",
    sourceUrl: "https://developers.docusign.com/platform/webhooks/connect/setting-up-hmac/",
    note: "The full key is visible only right after you create it — later views show just its first four characters — and deleting a key shifts the index of the keys below it",
  },
  mailgun: {
    displayName: "Mailgun",
    icon: "envelope",
    credentialName: "HTTP webhook signing key",
    credentialKind: "secret",
    where:
      "In the Mailgun control panel, open your profile menu and choose API Security, where the HTTP webhook signing key sits alongside your API keys",
    sourceUrl:
      "https://documentation.mailgun.com/docs/mailgun/user-manual/webhooks/securing-webhooks",
    note: "It is account-level rather than per-domain or per-webhook, so one key signs every webhook on the account, and resetting it takes effect immediately",
  },
  contentful: {
    displayName: "Contentful",
    icon: "layer-group",
    credentialName: "signing secret",
    credentialKind: "secret",
    where:
      "In the space, open Settings → Webhooks → the Settings tab and enable request verification, which generates the signing secret",
    sourceUrl:
      "https://www.contentful.com/developers/docs/extensibility/webhooks/request-verification/",
    note: "It is space-level — one secret covers every webhook in the space — and you cannot copy it again once you leave that view",
  },
  klaviyo: {
    displayName: "Klaviyo",
    icon: "chart-line",
    credentialName: "secret key",
    credentialKind: "secret",
    where:
      "You choose this value yourself when creating the webhook rather than Klaviyo generating it, either in the create-webhook form or as the secret_key field on the API request",
    sourceUrl: "https://developers.klaviyo.com/en/docs/working_with_system_webhooks",
    note: "It must be at least 16 characters, and Klaviyo never returns it afterwards, so record it as you create the webhook",
  },
};
