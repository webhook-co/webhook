import { cn } from "@webhook-co/ui";

import { PROVIDER_NAMES } from "@/components/marketing/provider-names";
import { SectionEyebrow } from "@/components/ui/section-eyebrow";
import { container, sectionPad } from "@/lib/styles";

/**
 * Every provider we can verify, named. This is the most credible thing the site owns and it was
 * invisible: the adapter registry shipped 142 providers while the homepage said "Stripe & GitHub
 * today, more soon".
 *
 * WHY NAMES AND NOT LOGOS. Two reasons, both deliberate:
 *  1. The dashboard's provider logos come from a dynamic favicon-proxy Worker route backed by R2.
 *     This site is a STATIC EXPORT with an `img-src 'self'` CSP and a hard 600 KB byte budget — that
 *     mechanism doesn't exist here, and 142 bundled logo files would blow the budget.
 *  2. Showing a provider's icon beside a user's own captured event (the dashboard) is nominative use.
 *     Papering a MARKETING page with 142 companies' logos implies an endorsement or partnership none
 *     of them have given us. Names state the same fact and claim nothing extra.
 *
 * The names come from `provider-names.ts`, which is GENERATED from the adapter registry and pinned
 * to it by `provider-wall.test.tsx` — so the wall cannot drift from what the code can actually
 * verify. (It's a flat literal rather than a live import because importing `webhooks-spec` here
 * drags the crypto package into this app's DOM-lib TS program and into the bundle.)
 */

export function ProviderWall() {
  return (
    <section aria-labelledby="providers" className={cn(container, sectionPad)}>
      <div className="mb-8 max-w-[60ch]">
        <SectionEyebrow className="mb-4">verification</SectionEyebrow>
        <h2
          id="providers"
          className="mb-4 text-[clamp(26px,3.4vw,36px)] leading-tight font-semibold tracking-heading text-balance text-fg"
        >
          {PROVIDER_NAMES.length} providers, built in
        </h2>
        <p className="text-md text-pretty text-fg-secondary">
          Point any of these at a webhook.co endpoint and its signature is checked on arrival — you
          don&rsquo;t write the verification code, and you don&rsquo;t store the secret in your app.
          When a signature fails, you get the reason, not a boolean.
        </p>
      </div>

      {/* A plain list: crawlable, zero client JS, and it reads as what it is — an inventory. */}
      <ul className="flex flex-wrap gap-x-2 gap-y-2">
        {PROVIDER_NAMES.map((name) => (
          <li
            key={name}
            className="rounded-control border border-hairline bg-surface px-2.5 py-1 font-mono text-xs text-fg-secondary"
          >
            {name}
          </li>
        ))}
      </ul>
    </section>
  );
}
