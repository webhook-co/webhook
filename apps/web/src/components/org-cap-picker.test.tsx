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

  it("rolls the tick back and reports when the action THROWS, not just when it returns ok:false", async () => {
    // setOrgKeepAction only wraps its DB write — verifySession / getTenantDb / isOrgOwner all throw straight
    // out of it. Without a try/catch around the await, the promise rejects, the override is never dropped,
    // and no error renders: the user is left staring at a tick that was never saved, for an org that
    // suspends in 14 days. The ok:false test below could never catch this; only a rejection can.
    setOrgKeepAction.mockRejectedValue(new Error("Hyperdrive blip"));
    render(<OrgCapPicker orgs={[org()]} cap={2} />);
    const box = screen.getByRole("checkbox", { name: "Keep Acme" });

    fireEvent.click(box);
    await screen.findByText("Couldn't save that just now. Try again.");
    await waitFor(() => expect(box).toHaveAttribute("data-state", "unchecked"));
    expect(refresh).not.toHaveBeenCalled();
  });

  it("re-syncs with refreshed props instead of holding a stale mirror", async () => {
    // The mark is org-level, so a co-owner can change it under you. A useState mirror seeded at mount would
    // never re-run, leaving a tick claiming "protected" beside a freshly-rendered suspension date from the
    // same row's props. State is derived from props + an in-flight override, so a re-render is the truth.
    const { rerender } = render(<OrgCapPicker orgs={[org({ keepRequestedByMe: true })]} cap={2} />);
    expect(screen.getByRole("checkbox", { name: "Keep Acme" })).toHaveAttribute(
      "data-state",
      "checked",
    );

    rerender(<OrgCapPicker orgs={[org({ keepRequestedByMe: false })]} cap={2} />);
    expect(screen.getByRole("checkbox", { name: "Keep Acme" })).toHaveAttribute(
      "data-state",
      "unchecked",
    );
  });

  it("does not freeze OTHER rows while one row is saving", async () => {
    // Each save is its own transaction; a shared pending flag disabled every checkbox for the round-trip and
    // silently swallowed clicks on unrelated rows.
    let release: (v: { ok: true }) => void = () => {};
    setOrgKeepAction.mockReturnValue(
      new Promise<{ ok: true }>((r) => {
        release = r;
      }),
    );
    render(
      <OrgCapPicker
        orgs={[org({ orgId: "a", name: "Acme" }), org({ orgId: "b", name: "Beta" })]}
        cap={2}
      />,
    );

    fireEvent.click(screen.getByRole("checkbox", { name: "Keep Acme" }));
    expect(screen.getByRole("checkbox", { name: "Keep Acme" })).toBeDisabled(); // its own row: yes
    expect(screen.getByRole("checkbox", { name: "Keep Beta" })).not.toBeDisabled(); // unrelated row: no
    release({ ok: true });
  });

  it("shows a PAID org unticked even if it carries a stale mark — the mark is inert there", async () => {
    // Reachable: mark a free org, then upgrade it. A ticked+disabled box the owner cannot clear would imply
    // the tick is doing something. It isn't — paid orgs are never counted toward the cap.
    render(
      <OrgCapPicker
        orgs={[org({ isFree: false, keepRequestedAt: new Date(), keepRequestedByMe: true })]}
        cap={2}
      />,
    );
    const box = screen.getByRole("checkbox", { name: "Keep Acme" });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("data-state", "unchecked");
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
