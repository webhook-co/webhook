// Hand-written adapters for providers whose verification CANNOT be expressed as one declarative HMAC
// config row — runtime-branching schemes (Twilio's form-vs-JSON modes), dynamic signed-header sets
// (Contentful), stateful URL/multi-sig glue (Plivo), or HS256-JWT schemes that bind the body via a
// hash claim rather than HMAC-ing the raw body (the S2.2 Tier-3 providers, on the ./jws primitive). The
// registry prefers a bespoke adapter over the config-derived one for any slug present here; everything
// else stays a single config row.

import type { VerifyAdapter } from "../../adapter";
import type { Provider } from "../config";
import { makeContentfulAdapter } from "./contentful";
import { makeMessagebirdAdapter } from "./messagebird";
import { makeNetlifyAdapter } from "./netlify";
import { makePlivoAdapter } from "./plivo";
import { makeTwilioAdapter } from "./twilio";
import { makeVonageAdapter } from "./vonage";

export const BESPOKE_ADAPTERS: Partial<Record<Provider, VerifyAdapter>> = {
  twilio: makeTwilioAdapter(),
  contentful: makeContentfulAdapter(),
  plivo: makePlivoAdapter(),
  // Tier-3 HS256-JWT (S2.2): a signed JWT with body/URL hash-claim binding, not an HMAC over the body.
  messagebird: makeMessagebirdAdapter(),
  netlify: makeNetlifyAdapter(),
  vonage: makeVonageAdapter(),
};
