import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The form uses the router (for the logo path) and renders the cropper (react-easy-crop). Stub both; capture
// the cropper's props so a test can drive its blob-capturing `upload`, and spy the router + the logo upload.
const { push, uploadOrgLogoWebp } = vi.hoisted(() => ({
  push: vi.fn(),
  uploadOrgLogoWebp: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push }) }));

let cropperProps: { upload: (b: Blob) => Promise<{ ok: true }>; onUploaded: () => void } | null =
  null;
vi.mock("./avatar-cropper", () => ({
  AvatarCropperDialog: (props: NonNullable<typeof cropperProps>) => {
    cropperProps = props;
    return null;
  },
}));
vi.mock("@/lib/avatar-upload", () => ({ uploadOrgLogoWebp }));
vi.mock("@/lib/crop-image", () => ({ fileToDataUrl: async () => "data:image/webp;base64,AAAA" }));

import { CreateTeamForm } from "./create-team-form";

// The logo-path action, injected everywhere; the no-logo tests below never trigger it.
const returnSlug = vi.fn(async () => ({ ok: true as const, slug: "acme" }));

afterEach(() => vi.clearAllMocks());

describe("CreateTeamForm", () => {
  it("previews the derived URL as you type the name", async () => {
    const user = userEvent.setup();
    render(
      <CreateTeamForm
        createReturningSlug={returnSlug}
        create={vi.fn(async () => ({ ok: false as const, error: "" }))}
      />,
    );

    await user.type(screen.getByLabelText("Organization name"), "Acme Engineering");
    // The preview shows the slugified base of the name (the server may add a suffix).
    expect(screen.getByText(/webhook\.co\/org\/acme-engineering/i)).toBeInTheDocument();
  });

  it("submits just the trimmed name for an untouched URL (the server derives the slug), and renders a server error inline", async () => {
    const create = vi.fn(async () => ({
      ok: false as const,
      error: "We couldn't create the organization.",
    }));
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "  Acme  ");
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const fd = create.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("Acme");
    // The auto-derived preview is NOT a choice — it's omitted so the server derives a valid unique slug.
    expect(fd.get("orgSlug")).toBeNull();
    expect(await screen.findByText(/couldn't create/i)).toBeInTheDocument();
  });

  it("submits the CHOSEN URL once the user edits the field", async () => {
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    const urlField = screen.getByLabelText("Organization URL");
    await user.clear(urlField);
    await user.type(urlField, "widgets"); // the user takes the URL over
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const fd = create.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("Acme");
    expect(fd.get("orgSlug")).toBe("widgets"); // the chosen URL rides along verbatim
  });

  it("still submits a name that slugifies to nothing — the server derives the slug, no dead-end", async () => {
    // A purely-symbolic name derives an empty slug. The old name-only form accepted it (server suffixed a
    // slug); requiring the derived slug would trap the user on a URL error they never asked for. It must submit.
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "!!!");
    const button = screen.getByRole("button", { name: "Create organization" });
    expect(button).toBeEnabled(); // no dead-end
    await user.click(button);

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    const fd = create.mock.calls[0]![0] as FormData;
    expect(fd.get("name")).toBe("!!!");
    expect(fd.get("orgSlug")).toBeNull(); // server derives it
  });

  it("still submits a short name whose derived slug would be too short — no untouched-URL error", async () => {
    // "Hi" derives "hi" (below the 3-char minimum). Because the user never touched the URL, this must NOT
    // surface a validation error or disable submit — the server derives a valid, suffixed slug instead.
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Hi");
    expect(screen.queryByText(/at least 3 characters/i)).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "Create organization" });
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect((create.mock.calls[0]![0] as FormData).get("orgSlug")).toBeNull();
  });

  it("the URL tracks the name until you edit the URL, then stops following it", async () => {
    const user = userEvent.setup();
    render(
      <CreateTeamForm
        createReturningSlug={returnSlug}
        create={vi.fn(async () => ({ ok: false as const, error: "" }))}
      />,
    );

    const nameField = screen.getByLabelText("Organization name");
    const urlField = screen.getByLabelText("Organization URL");
    await user.type(nameField, "Acme");
    expect(urlField).toHaveValue("acme"); // tracked from the name

    await user.clear(urlField);
    await user.type(urlField, "widgets"); // user takes the URL over
    await user.type(nameField, " Corp"); // name keeps changing…
    expect(urlField).toHaveValue("widgets"); // …but the URL no longer follows
  });

  it("disables submit and shows an inline error for an invalid URL", async () => {
    const create = vi.fn();
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    const urlField = screen.getByLabelText("Organization URL");
    await user.clear(urlField);
    await user.type(urlField, "Nope!!"); // uppercase + illegal chars → invalid slug
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Create organization" }));
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps the button disabled for an empty / whitespace-only name", async () => {
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
    await user.type(screen.getByLabelText("Organization name"), "   ");
    expect(screen.getByRole("button", { name: "Create organization" })).toBeDisabled();
  });

  it("with a chosen logo: creates (returning the slug), uploads the logo to it, then navigates", async () => {
    const create = vi.fn(); // the redirecting path must NOT be used when a logo is present
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    // Drive the (mocked) cropper's blob-capturing upload — as if the user cropped a logo.
    const blob = new Blob([new Uint8Array([1])], { type: "image/webp" });
    await cropperProps!.upload(blob);

    await user.click(screen.getByRole("button", { name: "Create organization" }));

    // The logo path: the RETURN-slug action (not the redirecting one), then upload to the new slug, then push.
    await waitFor(() => expect(returnSlug).toHaveBeenCalledOnce());
    expect(create).not.toHaveBeenCalled();
    // Uploaded to the new slug, with a bounded (abortable) signal so a stall can't strand the user.
    await waitFor(() =>
      expect(uploadOrgLogoWebp).toHaveBeenCalledWith(blob, {
        slug: "acme",
        signal: expect.any(AbortSignal),
      }),
    );
    await waitFor(() => expect(push).toHaveBeenCalledWith("/org/acme/dashboard?created=1"));
  });

  it("in the logo path, a failed create shows an inline error and does NOT upload or navigate", async () => {
    // The one new error branch the redirect/return-slug split introduces: create itself fails (cap hit, taken
    // slug). The form must render the error and stay put — no logo upload, no navigation.
    returnSlug.mockResolvedValueOnce({
      ok: false as const,
      error: "That URL is already taken. Try another.",
    });
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={vi.fn()} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    await cropperProps!.upload(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
    expect(uploadOrgLogoWebp).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("removing a captured logo reverts to the redirecting create path (no upload, no push)", async () => {
    const create = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={create} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    // Wrap the cropper's blob capture in act(): it sets `logo`, and the Remove button is conditional on it.
    await act(async () => {
      await cropperProps!.upload(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    });
    // A logo is now held → the Remove button appears; clicking it clears the logo.
    await user.click(screen.getByRole("button", { name: "Remove" }));
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    // Back on the plain redirecting path: `create` is used, the return-slug + upload + push are not.
    await waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(returnSlug).not.toHaveBeenCalled();
    expect(uploadOrgLogoWebp).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it("navigates even if the post-create logo upload fails (the org exists; logo can be added in settings)", async () => {
    uploadOrgLogoWebp.mockRejectedValueOnce(new Error("r2 down"));
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={vi.fn()} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    await cropperProps!.upload(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(push).toHaveBeenCalledWith("/org/acme/dashboard?created=1"));
  });

  it("navigates even when the upload RESOLVES ok:false (the real helper's failure shape, not a throw)", async () => {
    // Production uploadOrgLogoWebp catches its own errors/aborts and RESOLVES { ok: false } — it never throws.
    // This is the shape a stall/network-failure actually takes, so assert we still navigate on it (not only on
    // the belt-and-braces .catch that handles a thrown rejection).
    uploadOrgLogoWebp.mockResolvedValueOnce({ ok: false as const, error: "Upload failed." });
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={returnSlug} create={vi.fn()} />);

    await user.type(screen.getByLabelText("Organization name"), "Acme");
    await cropperProps!.upload(new Blob([new Uint8Array([1])], { type: "image/webp" }));
    await user.click(screen.getByRole("button", { name: "Create organization" }));

    await waitFor(() => expect(returnSlug).toHaveBeenCalledOnce());
    await waitFor(() => expect(push).toHaveBeenCalledWith("/org/acme/dashboard?created=1"));
    // No inline error is shown for a best-effort logo failure — the org exists and we moved on.
    expect(screen.queryByText(/upload failed/i)).not.toBeInTheDocument();
  });
});

describe("CreateTeamForm — logo sits WITH the identity fields, not below them", () => {
  it("renders the logo control and both fields in one section", async () => {
    render(<CreateTeamForm createReturningSlug={vi.fn()} create={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add logo/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Organization name")).toBeInTheDocument();
    expect(screen.getByLabelText("Organization URL")).toBeInTheDocument();
  });

  it("the logo buttons never submit the form — only 'Create organization' does", async () => {
    // They live INSIDE the <form> here (unlike settings), because capturing the crop IS part of creating.
    // That makes the explicit type the only thing standing between "Add logo" and an accidental submit.
    render(<CreateTeamForm createReturningSlug={vi.fn()} create={vi.fn()} />);
    expect(screen.getByRole("button", { name: /add logo/i })).toHaveAttribute("type", "button");
    expect(screen.getByRole("button", { name: /create organization/i })).toHaveAttribute(
      "type",
      "submit",
    );
  });

  it("falls back to the name's initial in the empty logo tile, and tracks the name", async () => {
    const user = userEvent.setup();
    render(<CreateTeamForm createReturningSlug={vi.fn()} create={vi.fn()} />);
    await user.type(screen.getByLabelText("Organization name"), "Acme");
    expect(screen.getByText("A")).toBeInTheDocument();
  });
});
