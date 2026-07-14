import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { OnboardingForm } from "./onboarding-form";

const props = (over: Partial<React.ComponentProps<typeof OnboardingForm>> = {}) => ({
  firstName: "Ada",
  lastName: "Lovelace",
  needsOrgName: true,
  defaultOrgName: "Ada Lovelace",
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
    render(<OnboardingForm {...props({ complete, defaultOrgName: "" })} />);

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
});
