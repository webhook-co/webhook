import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CopyButton } from "./copy-button";

// Some tests below replace navigator.clipboard with a mock. Capture the original so we can
// restore it after each test — otherwise a stubbed/rejecting clipboard would leak into any
// test that runs afterward.
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");

afterEach(() => {
  vi.useRealTimers();
  if (originalClipboardDescriptor) {
    Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "clipboard");
  }
});

describe("CopyButton", () => {
  it("renders with a default Copy label", () => {
    render(<CopyButton value="whsec_abc" />);
    expect(screen.getByRole("button", { name: /copy/i })).toBeInTheDocument();
  });

  it("writes the value to the clipboard when clicked", async () => {
    const user = userEvent.setup();
    render(<CopyButton value="whsec_abc123" />);
    await user.click(screen.getByRole("button", { name: /copy/i }));
    expect(await navigator.clipboard.readText()).toBe("whsec_abc123");
  });

  it("shows copied feedback and announces it via a live region", async () => {
    const user = userEvent.setup();
    render(<CopyButton value="whsec_abc" />);
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
  });

  it("calls onCopy with the value", async () => {
    const user = userEvent.setup();
    const onCopy = vi.fn();
    render(<CopyButton value="whsec_abc" onCopy={onCopy} />);
    await user.click(screen.getByRole("button"));
    expect(onCopy).toHaveBeenCalledWith("whsec_abc");
  });

  it("uses a custom label and copiedLabel", async () => {
    const user = userEvent.setup();
    render(<CopyButton value="x" label="Copy key" copiedLabel="Key copied" />);
    expect(screen.getByRole("button", { name: "Copy key" })).toBeInTheDocument();
    await user.click(screen.getByRole("button"));
    expect(screen.getByRole("status")).toHaveTextContent("Key copied");
  });

  it("forwards a ref to the underlying button", () => {
    const ref = createRef<HTMLButtonElement>();
    render(<CopyButton value="x" ref={ref} />);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it("does not claim success when the clipboard write fails", async () => {
    const onCopy = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
      configurable: true,
      writable: true,
    });
    render(<CopyButton value="x" onCopy={onCopy} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("status")).not.toHaveTextContent("Copied");
    expect(onCopy).not.toHaveBeenCalled();
  });

  it("reverts to the resting label after the timeout", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue();
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
      writable: true,
    });
    render(<CopyButton value="x" />);
    // fireEvent (not userEvent) avoids userEvent's own timer waits clashing with fake timers.
    await act(async () => {
      fireEvent.click(screen.getByRole("button"));
    });
    expect(screen.getByRole("status")).toHaveTextContent("Copied");
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.getByRole("status")).not.toHaveTextContent("Copied");
  });
});
