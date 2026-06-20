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
    // verified → a live region confirming, with a way on to the consent review
    expect(await screen.findByRole("status")).toHaveTextContent(/verified/i);
    expect(screen.getByRole("link", { name: /continue|review/i })).toHaveAttribute(
      "href",
      "/consent",
    );
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
