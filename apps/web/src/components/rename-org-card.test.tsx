import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

// The card now renders the logo control (the logo folded INTO this section), which calls useRouter to
// refresh after an upload — so the navigation mock has to carry it too.
// The logo tile renders an <img> against /api/org/... — stub it, same as the deleted logo-org-card test did,
// so we can assert it is PRESENT for a read-only member.
vi.mock("./org-avatar", () => ({ OrgAvatar: () => <div data-testid="org-avatar" /> }));
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  useRouter: () => ({ refresh: vi.fn() }),
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

  it("the logo buttons must NOT submit the rename form", async () => {
    // They sit in the adjacent column as siblings of the <form>, but a Button with no explicit type defaults
    // to submit INSIDE one — so if this ever gets nested, clicking "Upload logo" would silently fire a
    // rename. Pin the type rather than rely on the tree shape staying as it is.
    render(<RenameOrgCard {...props()} />);
    expect(screen.getByRole("button", { name: /upload logo/i })).toHaveAttribute("type", "button");
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
