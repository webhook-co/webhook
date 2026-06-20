import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { ConsentForm, mockConsentRequest } from "./consent-form";

export const metadata: Metadata = {
  title: "Authorize a request · webhook.co",
  description: "Review and approve an access request.",
};

export default function ConsentPage() {
  // E4 renders the mock request so the screen is buildable before Lane C's `/authorize` exists.
  // E8: Lane C SSRs the real ConsentRequest here (resolved from the authorization request id);
  // an absent/expired request renders the expired state instead of the form.
  const request = mockConsentRequest;

  return (
    <AuthShell homeHref="/" actions={<ThemeToggle />}>
      <ConsentForm request={request} />
    </AuthShell>
  );
}
