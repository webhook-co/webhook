// Hand-written adapters for providers whose verification CANNOT be expressed as one declarative HMAC
// config row — runtime-branching schemes (Twilio's form-vs-JSON modes), dynamic signed-header sets
// (Contentful), stateful URL/multi-sig glue (Plivo), or HS256-JWT schemes that bind the body via a
// hash claim rather than HMAC-ing the raw body (the S2.2 Tier-3 providers, on the ./jws primitive). The
// registry prefers a bespoke adapter over the config-derived one for any slug present here; everything
// else stays a single config row.

import type { VerifyAdapter } from "../../adapter";
import type { Provider } from "../config";
import { makeAwsSnsAdapter } from "./aws-sns";
import { makeContentfulAdapter } from "./contentful";
import { makeDiscordAdapter } from "./discord";
import { makeJiraConnectAdapter } from "./jira-connect";
import { makeKindeAdapter } from "./kinde";
import { makeMessagebirdAdapter } from "./messagebird";
import { makeMondayAdapter } from "./monday";
import { makeNetlifyAdapter } from "./netlify";
import { makePaypalAdapter } from "./paypal";
import { makePlaidAdapter } from "./plaid";
import { makePlivoAdapter } from "./plivo";
import { makeSendgridAdapter } from "./sendgrid";
import { makeTelnyxAdapter } from "./telnyx";
import { TOKEN_AUTH_ADAPTERS } from "./token-auth-providers";
import { makeTwilioAdapter } from "./twilio";
import { makeVonageAdapter } from "./vonage";
import { makeWiseAdapter } from "./wise";

export const BESPOKE_ADAPTERS: Partial<Record<Provider, VerifyAdapter>> = {
  twilio: makeTwilioAdapter(),
  contentful: makeContentfulAdapter(),
  plivo: makePlivoAdapter(),
  // Tier-3 HS256-JWT (S2.2): a signed JWT with body/URL hash-claim binding, not an HMAC over the body.
  messagebird: makeMessagebirdAdapter(),
  netlify: makeNetlifyAdapter(),
  vonage: makeVonageAdapter(),
  // Tier-3 HS256-JWT, origin-authenticated (no body-hash claim; Jira binds the request via qsh).
  monday: makeMondayAdapter(),
  jira_connect: makeJiraConnectAdapter(),
  // Tier-3 ASYMMETRIC Ed25519 (public-key verify over timestamp+body).
  discord: makeDiscordAdapter(),
  telnyx: makeTelnyxAdapter(),
  // Tier-3 ASYMMETRIC ECDSA-P256 (SendGrid) + RSA-PKCS1 (Wise).
  sendgrid: makeSendgridAdapter(),
  wise: makeWiseAdapter(),
  // Tier-3 REMOTE-FETCH — key fetched from the provider's JWKS/cert (engine-injected fetchKey).
  kinde: makeKindeAdapter(),
  paypal: makePaypalAdapter(),
  aws_sns: makeAwsSnsAdapter(),
  plaid: makePlaidAdapter(),
  // Tier-4 NON-CRYPTOGRAPHIC authenticity (A5) — static-token / HTTP-Basic equality, surfaced as the
  // weaker "authenticated" status (gitlab, microsoft_graph, chargebee, postmark, sparkpost, okta,
  // bigcommerce, datadog, brevo). Each built from the shared token-auth factory.
  ...TOKEN_AUTH_ADAPTERS,
};
