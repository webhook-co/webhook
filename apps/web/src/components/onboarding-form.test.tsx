import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OnboardingForm } from "./onboarding-form";

const props = (over: Partial<React.ComponentProps<typeof OnboardingForm>> = {}) => ({
  firstName: "Ada",
  lastName: "Lovelace",
  needsOrgName: true,
  defaultOrgName: "Ada Lovelace",
  // The org's LIVE slug seeds the URL field (a non-empty valid slug, so a fresh-signup form starts submittable);
  // tests that build the slug from scratch pass "" explicitly.
  defaultOrgSlug: "acme",
  complete: vi.fn(async () => ({ ok: true as const })),
  ...over,
});

describe("OnboardingForm", () => {
  it("arrives pre-filled with the mapped name", () => {
    render(<OnboardingForm {...props()} />);
    expect(screen.getByLabelText("First name")).toHaveValue("Ada");
    expect(screen.getByLabelText("Last name")).toHaveValue("Lovelace");
  });

  // An invited teammate already has a real org — they must not be asked to name one.
  it("hides the org fields for an invited teammate", () => {
    render(<OnboardingForm {...props({ needsOrgName: false })} />);
    expect(screen.queryByLabelText("Organization name")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Organization URL")).not.toBeInTheDocument();
  });

  it("submits first name, last name, org name and slug for a fresh signup", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, defaultOrgName: "" })} />);

    await userEvent.type(screen.getByLabelText("Organization name"), "Acme Inc");
    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const fd = complete.mock.calls[0][0] as FormData;
    expect(fd.get("firstName")).toBe("Ada");
    expect(fd.get("orgName")).toBe("Acme Inc");
    // The slug tracked the name.
    expect(fd.get("orgSlug")).toBe("acme-inc");
  });

  // The "name → URL" pair people expect: the slug follows the name until you touch it, then it is yours.
  it("stops overwriting the slug once the user edits it", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, defaultOrgName: "", defaultOrgSlug: "" })} />);

    const slug = screen.getByLabelText("Organization URL");
    await userEvent.type(slug, "my-team");
    // Now type a name — it must NOT clobber the hand-edited slug.
    await userEvent.type(screen.getByLabelText("Organization name"), "Acme");
    expect(slug).toHaveValue("my-team");

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect((complete.mock.calls[0][0] as FormData).get("orgSlug")).toBe("my-team");
  });

  it("sends no org fields when the org step is hidden", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, needsOrgName: false })} />);

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    const fd = complete.mock.calls[0][0] as FormData;
    expect(fd.get("orgName")).toBeNull();
    expect(fd.get("orgSlug")).toBeNull();
  });

  it("surfaces a server field error without navigating", async () => {
    const complete = vi.fn(async () => ({
      ok: false as const,
      error: "That URL is already taken.",
      field: "orgSlug" as const,
    }));
    render(<OnboardingForm {...props({ complete, defaultOrgName: "Acme" })} />);

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
  });

  it("refuses to submit an empty first name", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete })} />);

    await userEvent.clear(screen.getByLabelText("First name"));
    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(complete).not.toHaveBeenCalled();
  });

  // A fresh signup must NAME their org — clearing the pre-filled field must not silently onboard them with the
  // machine-generated name. The submit is disabled and the action is never called.
  it("blocks a fresh signup from submitting an empty org name", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, defaultOrgName: "" })} />);

    const button = screen.getByRole("button", { name: /get started/i });
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(complete).not.toHaveBeenCalled();
  });

  it("re-enables submit once the org name is filled in", async () => {
    render(<OnboardingForm {...props({ defaultOrgName: "" })} />);
    const button = screen.getByRole("button", { name: /get started/i });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText("Organization name"), "Acme");
    expect(button).toBeEnabled();
  });

  // A non-empty name with a CLEARED URL must also block: an empty slug can't be quietly accepted and rejected
  // only on the server round-trip.
  it("blocks submit when the org URL is cleared even though the name is filled", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, defaultOrgName: "Acme" })} />);

    const button = screen.getByRole("button", { name: /get started/i });
    expect(button).toBeEnabled();
    await userEvent.clear(screen.getByLabelText("Organization URL"));
    expect(button).toBeDisabled();
    await userEvent.click(button);
    expect(complete).not.toHaveBeenCalled();
  });

  // [review] On a partial-failure retry the org is already renamed, so its name and slug diverge. The form
  // must seed the URL from the LIVE slug, not slugify(name) — otherwise an untouched resubmit would rotate the
  // URL and permanently burn the slug the user chose.
  it("seeds the URL from the org's live slug (not the name), so an untouched resubmit keeps it", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(
      <OnboardingForm
        {...props({ complete, defaultOrgName: "Acme", defaultOrgSlug: "acme-team" })}
      />,
    );
    expect(screen.getByLabelText("Organization URL")).toHaveValue("acme-team");

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect((complete.mock.calls[0][0] as FormData).get("orgSlug")).toBe("acme-team");
  });

  // [review] Live validation must match what is SUBMITTED (the trimmed slug) — a trailing space (easy on
  // paste) must not disable submit with a spurious format error.
  it("does not block submit on a slug with surrounding whitespace (validates trimmed)", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, defaultOrgName: "Acme", defaultOrgSlug: "" })} />);

    const slugField = screen.getByLabelText("Organization URL");
    await userEvent.type(slugField, "my-org ");
    const button = screen.getByRole("button", { name: /get started/i });
    expect(button).toBeEnabled();

    await userEvent.click(button);
    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect((complete.mock.calls[0][0] as FormData).get("orgSlug")).toBe("my-org");
  });

  it("carries a whitelisted invite flag into the submitted form data", async () => {
    const complete = vi.fn(async () => ({ ok: true as const }));
    render(<OnboardingForm {...props({ complete, needsOrgName: false, invite: "accepted" })} />);

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    await waitFor(() => expect(complete).toHaveBeenCalledOnce());
    expect((complete.mock.calls[0][0] as FormData).get("invite")).toBe("accepted");
  });

  // A successful submit REDIRECTS — the action throws a NEXT_REDIRECT digest. That must propagate (so Next
  // navigates), NOT be caught and shown as "something went wrong". Here we assert the false banner never
  // appears; the re-thrown redirect is the intended control flow.
  it("does not show a false error banner when the action redirects on success", async () => {
    const redirectErr = Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/org/acme/dashboard;307;",
    });
    const complete = vi.fn(async () => {
      throw redirectErr;
    });
    // onSubmit RE-THROWS the redirect so Next can navigate — correct in the app (Next catches it), but here it
    // becomes a floating rejection with no framework to catch it. Swallow exactly that redirect for this test.
    const swallow = (reason: unknown) => {
      if (reason !== redirectErr) throw reason;
    };
    process.on("unhandledRejection", swallow);
    try {
      render(<OnboardingForm {...props({ complete, needsOrgName: false })} />);
      await userEvent.click(screen.getByRole("button", { name: /get started/i }));
      await waitFor(() => expect(complete).toHaveBeenCalledOnce());
      await new Promise((r) => setTimeout(r, 0)); // let the floating rejection settle
      expect(screen.queryByText(/something went wrong/i)).not.toBeInTheDocument();
    } finally {
      process.off("unhandledRejection", swallow);
    }
  });

  // A GENUINE error (not a redirect) still surfaces the generic banner.
  it("shows a generic error when the action throws a non-redirect error", async () => {
    const complete = vi.fn(async () => {
      throw new Error("network boom");
    });
    render(<OnboardingForm {...props({ complete, needsOrgName: false })} />);

    await userEvent.click(screen.getByRole("button", { name: /get started/i }));

    expect(await screen.findByText(/something went wrong/i)).toBeInTheDocument();
  });
});
