import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The card now renders the logo control (the logo folded INTO this section), which calls useRouter to
// refresh after an upload — so the navigation mock has to carry it too.
// The logo tile renders an <img> against /api/org/... — stub it, same as the deleted logo-org-card test did,
// so we can assert it is PRESENT for a read-only member. It renders its `name` so we can also assert WHICH
// name it was given: a stub that swallows props can't tell a live value from a stale one.
vi.mock("./org-avatar", () => ({
  OrgAvatar: ({ name }: { name: string }) => <div data-testid="org-avatar">{name}</div>,
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { removeOrgLogo, uploadOrgLogoWebp } = vi.hoisted(() => ({
  removeOrgLogo: vi.fn(async () => ({ ok: true as const })),
  uploadOrgLogoWebp: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/avatar-upload", () => ({ removeOrgLogo, uploadOrgLogoWebp }));
vi.mock("@/lib/org-logo-version", () => ({ orgLogoVersion: { bump: vi.fn() } }));

// The real cropper is a canvas/file-picker dialog with no headless success path. Stub it down to the one
// thing this card cares about: a control that fires `onUploaded`, i.e. "an upload just succeeded".
vi.mock("./avatar-cropper", () => ({
  AvatarCropperDialog: ({ onUploaded }: { onUploaded: () => void }) => (
    <button type="button" onClick={onUploaded}>
      simulate upload
    </button>
  ),
}));

import { RenameOrgCard } from "./rename-org-card";

const props = (over: Partial<Parameters<typeof RenameOrgCard>[0]> = {}) => ({
  slug: "acme",
  name: "Acme",
  rename: vi.fn(async () => ({ ok: false as const, error: "" })),
  canRename: true,
  hasLogo: false,
  ...over,
});

afterEach(() => vi.clearAllMocks());

describe("RenameOrgCard", () => {
  it("shows a live validation error for a bad slug and disables save", async () => {
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);

    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "no"); // too short

    expect(screen.getByText(/at least 3/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("catches a reserved slug live — and says it's reserved, not malformed", async () => {
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);

    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "settings");

    expect(screen.getByText(/reserved/i)).toBeInTheDocument();
  });

  it("submits name + slug and renders a server error inline", async () => {
    const rename = vi.fn(async () => ({
      ok: false as const,
      error: "That URL is already taken. Try another.",
    }));
    const user = userEvent.setup();
    render(<RenameOrgCard {...props({ rename })} />);

    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "acme-new");
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(rename).toHaveBeenCalledOnce());
    const fd = rename.mock.calls[0]![0] as FormData;
    expect(fd.get("slug")).toBe("acme-new");
    expect(await screen.findByText(/already taken/i)).toBeInTheDocument();
  });

  it("keeps save disabled when nothing has changed", () => {
    render(<RenameOrgCard {...props()} />);
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
  });

  it("is READ-ONLY for a member — no save button, inputs disabled", () => {
    render(<RenameOrgCard {...props({ canRename: false })} />);
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeDisabled();
    expect(screen.getByLabelText("URL")).toBeDisabled();
  });

  it("calls the tenant an ORGANIZATION in the slug hint — 'team' means the people page only", async () => {
    // Standing rule: "organization" is the tenant; "Team" is the members surface, exclusively. This hint sits
    // one line under a CardDescription that says "Your organization's logo, name, and URL", and produces the
    // identical sentence create-team-form renders as "Your organization will live at…". Two surfaces
    // describing the same object must not disagree about what the object is called.
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);
    await user.clear(screen.getByLabelText("URL"));
    await user.type(screen.getByLabelText("URL"), "acme-new");

    expect(
      screen.getByText(/your organization will live at webhook\.co\/org\/acme-new/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/your team will live at/i)).toBeNull();
  });

  it("lowercases slug input as you type (the DB is case-sensitive on the URL)", async () => {
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);
    const url = screen.getByLabelText("URL");
    await user.clear(url);
    await user.type(url, "ACME-New");
    expect(url).toHaveValue("acme-new");
  });
});

describe("RenameOrgCard — the logo lives IN this section", () => {
  it("renders the logo control alongside the fields, not as a separate section", async () => {
    render(<RenameOrgCard {...props()} />);
    // One "Organization" section that owns all three: logo, name, URL.
    expect(screen.getByRole("button", { name: /upload logo/i })).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.getByLabelText("URL")).toBeInTheDocument();
  });

  it("offers Remove only when a logo exists", async () => {
    const { rerender } = render(<RenameOrgCard {...props({ hasLogo: true })} />);
    expect(screen.getByRole("button", { name: /change logo/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();

    rerender(<RenameOrgCard {...props({ hasLogo: false })} />);
    expect(screen.getByRole("button", { name: /upload logo/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
  });

  it("clicking a logo control never fires the rename", async () => {
    // Asserting `type="button"` here proved nothing: the shared Button renders `type={type ?? "button"}`
    // unconditionally, so that attribute is guaranteed no matter where the control sits — the test passed by
    // construction and would have passed had it been nested in the form. Assert the BEHAVIOUR instead: no
    // logo interaction may submit the rename, whatever the tree shape.
    const rename = vi.fn(async () => ({ ok: false as const, error: "" }));
    const user = userEvent.setup();
    render(<RenameOrgCard {...props({ rename })} />);
    await user.click(screen.getByRole("button", { name: /upload logo/i }));
    expect(rename).not.toHaveBeenCalled();
  });

  it("the logo tile tracks the name you're TYPING, not the one the server last saved", async () => {
    // The tile sits directly beside the Name field and the card calls the two 'one thing' — so a generated
    // monogram frozen on the old name while you retype it reads as a broken control. create-team-form already
    // tracks the live value; these two surfaces were restructured to be the same shape and must behave alike.
    const user = userEvent.setup();
    render(<RenameOrgCard {...props()} />);
    expect(screen.getByTestId("org-avatar")).toHaveTextContent("Acme");

    await user.clear(screen.getByLabelText("Name"));
    await user.type(screen.getByLabelText("Name"), "Beta");
    expect(screen.getByTestId("org-avatar")).toHaveTextContent("Beta");
  });

  it("clears a stale logo error once a later upload succeeds", async () => {
    // The error banner is delegated up to this card and rendered full-width under both columns, so a failed
    // Remove leaves a loud red banner. If a subsequent successful upload doesn't clear it, the user ends up
    // looking at their visibly-updated new logo with "failed" still sitting beneath it. router.refresh()
    // re-reads the server but does not reset client state, so nothing else clears it.
    const user = userEvent.setup();
    removeOrgLogo.mockResolvedValue({ ok: false, error: "Could not remove the logo." });
    render(<RenameOrgCard {...props({ hasLogo: true })} />);

    await user.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(await screen.findByText(/could not remove the logo/i)).toBeInTheDocument();

    // The cropper dialog is stubbed to expose its onUploaded — fire the success path directly.
    await user.click(screen.getByRole("button", { name: /simulate upload/i }));
    await waitFor(() => expect(screen.queryByText(/could not remove the logo/i)).toBeNull());
  });

  it("hides the logo CONTROLS for a member but still SHOWS the logo — read-only, not absent", async () => {
    // Both halves. The deleted logo-org-card test asserted the positive one too, and dropping it unpins the
    // invariant: everything else in that canManage branch is role-gated, so folding the avatar inside it is
    // the obvious "tidy-up" — and it would leave a member's Organization card showing a name and a URL and no
    // logo at all, which is not read-only, it's missing.
    render(<RenameOrgCard {...props({ canRename: false, hasLogo: true })} />);
    expect(screen.queryByRole("button", { name: /change logo/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /^remove$/i })).toBeNull();
    expect(screen.getByTestId("org-avatar")).toBeInTheDocument();
  });
});
