"use client";

import { Banner, Button, Field } from "@webhook-co/ui";
import { orgSlugErrorMessage, slugifyOrgName, validateOrgSlug } from "@webhook-co/shared";
import * as React from "react";

import type { CompleteOnboardingResult } from "@/server/onboarding-actions";

export interface OnboardingFormProps {
  readonly firstName: string;
  readonly lastName: string;
  /** Fresh signup → let them name their org. Invited teammate → name only. */
  readonly needsOrgName: boolean;
  readonly defaultOrgName: string;
  readonly complete: (formData: FormData) => Promise<CompleteOnboardingResult>;
}

/**
 * The one-screen onboarding form.
 *
 * ONE screen, and pre-filled, on purpose. A social signup already gave us a name — asking them to type it
 * again would be busywork — so the fields arrive filled and the user mostly just confirms. A magic-link signup
 * gets a best-effort split of whatever name they have, to correct. And a fresh signup names their org here so
 * they never have to live with the machine-generated `dana-a3f19c` we had to create at signup; an INVITED
 * teammate skips that entirely (they already have a real org — `needsOrgName` is false).
 *
 * The org SLUG tracks the name as you type, but only until you touch the slug yourself — after that it is
 * yours and the name stops overwriting it. That is the behaviour people expect from a "name → URL" pair, and
 * getting it wrong (clobbering a hand-edited slug on the next keystroke) is a small thing that feels broken.
 */
export function OnboardingForm({
  firstName: initialFirst,
  lastName: initialLast,
  needsOrgName,
  defaultOrgName,
  complete,
}: OnboardingFormProps) {
  const [firstName, setFirstName] = React.useState(initialFirst);
  const [lastName, setLastName] = React.useState(initialLast);
  const [orgName, setOrgName] = React.useState(defaultOrgName);
  const [slug, setSlug] = React.useState(slugifyOrgName(defaultOrgName));
  const [slugTouched, setSlugTouched] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [fieldError, setFieldError] = React.useState<
    "firstName" | "orgName" | "orgSlug" | undefined
  >(undefined);

  // The live slug validity — the server re-checks authoritatively, but showing it here saves a round trip on
  // an obvious mistake.
  const slugCheck = needsOrgName && slug ? validateOrgSlug(slug) : { ok: true as const };
  const slugError = !slugCheck.ok ? orgSlugErrorMessage(slugCheck.reason) : null;

  function onOrgName(next: string) {
    setOrgName(next);
    // The slug follows the name until the user takes the slug over.
    if (!slugTouched) setSlug(slugifyOrgName(next));
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setFieldError(undefined);
    if (firstName.trim().length === 0) {
      setFieldError("firstName");
      setError("Tell us your first name.");
      return;
    }
    setPending(true);
    try {
      const fd = new FormData();
      fd.set("firstName", firstName.trim());
      fd.set("lastName", lastName.trim());
      if (needsOrgName) {
        fd.set("orgName", orgName.trim());
        fd.set("orgSlug", slug.trim());
      }
      const res = await complete(fd);
      // On success the action REDIRECTS (so it never returns here); a returned result is always a failure.
      if (res && !res.ok) {
        setError(res.error);
        setFieldError(res.field);
      }
    } catch {
      // A redirect throw is Next's success signal — let it propagate; only a real error lands here.
      setError("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Welcome to webhook.co</h1>
        <p className="leading-snug text-fg-secondary">
          {needsOrgName ? "A couple of details and you're in." : "Just your name and you're in."}
        </p>
      </div>

      {error ? <Banner tone="danger">{error}</Banner> : null}

      <form className="flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <div className="flex flex-col gap-4 sm:flex-row">
          <Field
            label="First name"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            disabled={pending}
            autoComplete="given-name"
            error={fieldError === "firstName" ? " " : undefined}
            className="flex-1"
          />
          <Field
            label="Last name"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            disabled={pending}
            autoComplete="family-name"
            className="flex-1"
          />
        </div>

        {needsOrgName ? (
          <>
            <Field
              label="Organization name"
              value={orgName}
              onChange={(e) => onOrgName(e.target.value)}
              disabled={pending}
              placeholder="Acme Inc"
              error={fieldError === "orgName" ? " " : undefined}
            />
            <Field
              label="Organization URL"
              value={slug}
              onChange={(e) => {
                setSlugTouched(true);
                setSlug(e.target.value);
              }}
              disabled={pending}
              spellCheck={false}
              autoCapitalize="none"
              // The URL preview lives in the hint (the codebase pattern) — one source with the server's copy.
              hint={
                slugError
                  ? undefined
                  : `Your organization will live at webhook.co/org/${slug || "…"}`
              }
              error={slugError ?? (fieldError === "orgSlug" ? " " : undefined)}
            />
          </>
        ) : null}

        <Button
          type="submit"
          loading={pending}
          disabled={firstName.trim().length === 0 || Boolean(slugError)}
        >
          Get started
        </Button>
      </form>
    </div>
  );
}
