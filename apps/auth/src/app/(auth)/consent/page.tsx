import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { ConsentActionsClient } from "./consent-actions";
import { resolveConsentRequest } from "./resolve-consent";

export const metadata: Metadata = {
  title: "Authorize a request · webhook.co",
  description: "Review and approve an access request.",
};

// Reads the per-request `?ticket=` + the signing secret, so it can't be statically rendered.
export const dynamic = "force-dynamic";

export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<{ ticket?: string }>;
}) {
  // Lane C's /authorize (or /device/verify) redirects here with a signed consent ticket. Resolve it to
  // the display request; an absent/forged/expired ticket renders the invalid state rather than a form.
  const { ticket } = await searchParams;
  const request = await resolveConsentRequest(ticket);

  return (
    <AuthShell homeHref="/" actions={<ThemeToggle />}>
      {request ? (
        <ConsentActionsClient request={request} />
      ) : (
        <div className="flex flex-col gap-1.5" role="status">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">
            This request can&apos;t be completed
          </h1>
          <p className="leading-snug text-fg-secondary">
            The authorization request is invalid or has expired. Start again from the app or device
            that sent you here.
          </p>
        </div>
      )}
    </AuthShell>
  );
}
