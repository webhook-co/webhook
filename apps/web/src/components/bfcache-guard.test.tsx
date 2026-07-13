import { render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BfcacheGuard } from "./bfcache-guard";

// A bfcache restore resurrects the document from memory: no request, no server render, no session check. The
// ONLY thing standing between a signed-out browser and a repainted signed-in page is this reload — so the
// test has to prove the reload actually fires, and fires on the right signal.

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  // jsdom's window.location.reload is not configurable in place; swap the whole descriptor.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** `pageshow` with `persisted` — jsdom has no PageTransitionEvent constructor, so build it by hand. */
function firePageShow(persisted: boolean) {
  const event = new Event("pageshow") as Event & { persisted?: boolean };
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

describe("BfcacheGuard", () => {
  it("reloads when the page is restored from the back/forward cache", () => {
    render(<BfcacheGuard />);

    firePageShow(true);

    expect(reload).toHaveBeenCalledOnce();
  });

  // If this fired on a normal load it would be an infinite reload loop on every page view — so the
  // `persisted` discriminator is load-bearing in BOTH directions, not just the positive one.
  it("does NOT reload on a normal page load", () => {
    render(<BfcacheGuard />);

    firePageShow(false);

    expect(reload).not.toHaveBeenCalled();
  });

  it("renders nothing", () => {
    const { container } = render(<BfcacheGuard />);
    expect(container).toBeEmptyDOMElement();
  });

  // A listener left on `window` after the tree unmounts would fire against a dead component — and, worse,
  // would keep reloading after a client-side navigation away from the gated shell.
  it("removes the listener on unmount", () => {
    const { unmount } = render(<BfcacheGuard />);

    unmount();
    firePageShow(true);

    expect(reload).not.toHaveBeenCalled();
  });
});
