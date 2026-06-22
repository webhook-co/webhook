import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { DeviceForm, type DeviceActions } from "./device-form";

function makeActions(over: Partial<DeviceActions> = {}): DeviceActions {
  return { verifyCode: vi.fn().mockResolvedValue(undefined), ...over };
}

describe("DeviceForm", () => {
  it("renders the code-entry form", () => {
    render(<DeviceForm actions={makeActions()} />);
    expect(screen.getByLabelText(/device code/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /continue/i })).toBeInTheDocument();
  });

  it("rejects a malformed code without calling the action", async () => {
    const actions = makeActions();
    render(<DeviceForm actions={actions} />);
    await userEvent.type(screen.getByLabelText(/device code/i), "abc");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(actions.verifyCode).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/code shown on your device/i);
  });

  it("normalizes case/spacing and verifies a well-formed code", async () => {
    const actions = makeActions();
    render(<DeviceForm actions={actions} />);
    await userEvent.type(screen.getByLabelText(/device code/i), "wxyz1234");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(actions.verifyCode).toHaveBeenCalledWith("WXYZ-1234");
    // verified → a live region confirming; the live action navigates to the server's redirect (which
    // carries the consent ticket), so there is NO manual link to a bare /consent (it'd lack the ticket).
    expect(await screen.findByRole("status")).toHaveTextContent(/verified/i);
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });

  it("pre-fills the code from initialCode (normalized) and does NOT auto-submit", () => {
    // verification_uri_complete carries ?user_code; pre-fill saves typing, but RFC 8628 §3.3.1
    // anti-phishing requires the user to confirm the code matches their device + click Continue.
    const actions = makeActions();
    render(<DeviceForm actions={actions} initialCode="yym9-6sn5" />);
    expect(screen.getByLabelText(/device code/i)).toHaveValue("YYM9-6SN5");
    expect(actions.verifyCode).not.toHaveBeenCalled();
  });

  it("focuses the pre-filled field with the caret at the END (not selected, not at the start)", () => {
    render(<DeviceForm actions={makeActions()} initialCode="YYM9-6SN5" />);
    const input = screen.getByLabelText(/device code/i) as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe("YYM9-6SN5".length);
    expect(input.selectionEnd).toBe("YYM9-6SN5".length);
  });

  it("does NOT autofocus when there is no pre-filled code", () => {
    render(<DeviceForm actions={makeActions()} />);
    expect(screen.getByLabelText(/device code/i)).not.toHaveFocus();
  });

  it("normalizes a messy initialCode (lowercase, no dash) for the pre-fill", () => {
    render(<DeviceForm actions={makeActions()} initialCode="yym96sn5" />);
    expect(screen.getByLabelText(/device code/i)).toHaveValue("YYM9-6SN5");
  });

  it("surfaces an error when the code is rejected", async () => {
    const actions = makeActions({ verifyCode: vi.fn().mockRejectedValue(new Error("nope")) });
    render(<DeviceForm actions={actions} />);
    await userEvent.type(screen.getByLabelText(/device code/i), "WXYZ-1234");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/isn't valid or has expired/i);
    // still usable
    expect(screen.getByRole("button", { name: /continue/i })).toBeEnabled();
  });
});
