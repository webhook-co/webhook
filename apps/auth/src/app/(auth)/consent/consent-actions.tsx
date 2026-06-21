"use client";

import type { ConsentRequest } from "@webhook-co/contract";

import { makeConsentActions } from "@/runtime/consent-client";

import { ConsentForm } from "./consent-form";

/**
 * Client wrapper: injects the live consent action (POST /consent/decision, bound to this request's id +
 * csrf) into Lane E's ConsentForm. The UI is unchanged — only the seam goes live (E8a).
 */
export function ConsentActionsClient({ request }: { request: ConsentRequest }) {
  return <ConsentForm request={request} actions={makeConsentActions(request)} />;
}
