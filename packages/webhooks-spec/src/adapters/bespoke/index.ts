// Hand-written adapters for providers whose verification CANNOT be expressed as one declarative HMAC
// config row — runtime-branching schemes (Twilio's form-vs-JSON modes), dynamic signed-header sets
// (Contentful), or stateful URL/multi-sig glue (Plivo). The registry prefers a bespoke adapter over the
// config-derived one for any slug present here; everything else stays a single config row.

import type { VerifyAdapter } from "../../adapter";
import type { Provider } from "../config";
import { makeTwilioAdapter } from "./twilio";

export const BESPOKE_ADAPTERS: Partial<Record<Provider, VerifyAdapter>> = {
  twilio: makeTwilioAdapter(),
};
