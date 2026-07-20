"use client";

import { Button, cn } from "@webhook-co/ui";
import { useEffect, useState } from "react";

import { consentWrites, readConsent, type ConsentDecision } from "@/lib/consent";
import { container, focusRing } from "@/lib/styles";

/**
 * Cookie-consent banner. `wh_first_touch` is a non-essential attribution cookie, so under ePrivacy it may
 * only be stored after consent — this banner is where that consent is asked for and recorded.
 *
 * Client island by necessity: a static export has no server to read the cookie, so the decision is made in
 * the browser. It renders nothing until an effect confirms no choice has been recorded yet (so a prerender
 * and the first client paint agree on "nothing", avoiding a hydration mismatch), then appears. Accept and
 * Reject are one click each, same layer, equal prominence — reject is as easy as accept. On Accept it also
 * promotes the current URL's utm to first-touch in the same gesture (see consentWrites); on Reject it
 * records the denial and clears any first-touch cookie. All cookie strings come from the pure @/lib/consent.
 */
export function ConsentBanner() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (readConsent(document.cookie) === null) setVisible(true);
  }, []);

  function choose(decision: ConsentDecision) {
    const { consent, firstTouch } = consentWrites(
      decision,
      { search: window.location.search, hostname: window.location.hostname },
      document.cookie,
    );
    document.cookie = consent;
    if (firstTouch) document.cookie = firstTouch;
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t border-hairline bg-surface-raised shadow-2"
    >
      <div
        className={cn(
          container,
          "flex flex-col gap-3 py-3.5 text-sm text-fg-secondary sm:flex-row sm:items-center sm:justify-between",
        )}
      >
        <p className="max-w-2xl">
          We set one first-party cookie to see which channels bring developers to webhook.co — its
          utm tags only, never personal data.{" "}
          <a
            href="/privacy#cookies"
            className={cn(
              focusRing,
              "rounded-control text-fg underline decoration-strong underline-offset-2 transition-colors hover:decoration-fg",
            )}
          >
            Privacy
          </a>
          .
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="secondary" size="sm" onClick={() => choose("denied")}>
            Reject
          </Button>
          <Button variant="primary" size="sm" onClick={() => choose("granted")}>
            Accept
          </Button>
        </div>
      </div>
    </div>
  );
}
