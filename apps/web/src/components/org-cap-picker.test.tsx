import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { setOrgKeepAction, refresh } = vi.hoisted(() => ({
  setOrgKeepAction: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@/server/org-cap-actions", () => ({ setOrgKeepAction }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));

import { OrgCapPicker, type OrgCapPickerOrg } from "./org-cap-picker";

const org = (over: Partial<OrgCapPickerOrg> = {}): OrgCapPickerOrg => ({
  orgId: "org_1",
  slug: "acme",
  name: "Acme",
  isFree: true,
  status: "active",
  keepRequestedAt: null,
  keepRequestedByMe: false,
  graceUntil: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  setOrgKeepAction.mockResolvedValue({ ok: true });
});

describe("OrgCapPicker", () => {
  it("saves a mark per checkbox — the write is one org per transaction, so the UI matches", async () => {
    render(<OrgCapPicker orgs={[org()]} cap={2} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Keep Acme" }));
    await waitFor(() => expect(setOrgKeepAction).toHaveBeenCalledWith("org_1", true));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it("rolls the optimistic tick BACK when the save fails, and says why", async () => {
    setOrgKeepAction.mockResolvedValue({
      ok: false,
      error: "You can only change organizations you own.",
    });
    render(<OrgCapPicker orgs={[org()]} cap={2} />);
    const box = screen.getByRole("checkbox", { name: "Keep Acme" });

    fireEvent.click(box);
    await screen.findByText("You can only change organizations you own.");
    // The tick must not survive a failed save — a checkbox that stays ticked is a lie about stored state.
    expect(box).toHaveAttribute("data-state", "unchecked");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("won't let a PAID org be ticked — it never counts toward the free limit", async () => {
    render(<OrgCapPicker orgs={[org({ isFree: false, name: "Paid Co" })]} cap={2} />);
    expect(screen.getByRole("checkbox", { name: "Keep Paid Co" })).toBeDisabled();
    expect(screen.getByText(/never counts toward the free limit/i)).toBeInTheDocument();
  });

  it("warns only when actually over the cap, and counts FREE orgs only", async () => {
    const under = [org({ orgId: "a" }), org({ orgId: "b", isFree: false })]; // 1 free, 1 paid
    const { rerender } = render(<OrgCapPicker orgs={under} cap={2} />);
    expect(screen.queryByText(/over the limit/i)).not.toBeInTheDocument();

    rerender(
      <OrgCapPicker
        orgs={[org({ orgId: "a" }), org({ orgId: "b" }), org({ orgId: "c" })]}
        cap={2}
      />,
    );
    expect(screen.getByText(/which is 1 over the limit of 2/i)).toBeInTheDocument();
  });

  it("tells the truth when more than `cap` are ticked instead of pretending to block it", async () => {
    // "At most cap marked" is unenforceable at write time (one org per transaction; a second tab can always
    // overshoot), and the reconciler re-validates by slicing at cap regardless. So state the outcome.
    const marked = new Date();
    render(
      <OrgCapPicker
        orgs={[
          org({ orgId: "a", keepRequestedAt: marked, keepRequestedByMe: true }),
          org({ orgId: "b", keepRequestedAt: marked, keepRequestedByMe: true }),
          org({ orgId: "c", keepRequestedAt: marked, keepRequestedByMe: true }),
        ]}
        cap={2}
      />,
    );
    expect(screen.getByText(/We'll keep the 2 oldest of the ones you ticked/i)).toBeInTheDocument();
  });

  it("does NOT show a CO-OWNER's mark as ticked — it does nothing for this user's ranking", async () => {
    // The mark is a column on the org, so every co-owner sees it. But the reconciler only honours it against
    // its author's list. Rendering someone else's mark as your tick would say "this slot is safe" when your
    // own ranking is entirely unaffected — and the org could still be the one that suspends.
    render(
      <OrgCapPicker
        orgs={[org({ keepRequestedAt: new Date(), keepRequestedByMe: false })]}
        cap={2}
      />,
    );
    expect(screen.getByRole("checkbox", { name: "Keep Acme" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("never predicts which org will be suspended — it can't know", async () => {
    // A co-owned org is overflow if it's overflow for ANY owner, and this surface can't see another user's
    // orgs. It shows the deadline the reconciler already set; it does not forecast one.
    render(
      <OrgCapPicker
        orgs={[org({ orgId: "a" }), org({ orgId: "b" }), org({ orgId: "c" })]}
        cap={2}
      />,
    );
    expect(screen.queryByText(/will be suspended|this one will/i)).not.toBeInTheDocument();
  });

  it("shows a real grace deadline once the reconciler has set one, in UTC", async () => {
    render(<OrgCapPicker orgs={[org({ graceUntil: new Date("2026-07-30T09:15:00Z") })]} cap={2} />);
    expect(
      screen.getByText(/Scheduled to be suspended on Jul 30, 2026 \(UTC\)/),
    ).toBeInTheDocument();
  });

  it("renders an empty state rather than a bare card when you own nothing", async () => {
    render(<OrgCapPicker orgs={[]} cap={2} />);
    expect(screen.getByText(/don't own any organizations yet/i)).toBeInTheDocument();
  });
});
