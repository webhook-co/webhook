import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import RootLayout from "./layout";

// The bfcache guard is the ONLY thing that re-checks the session after a back/forward-cache restore — a
// restore runs no request, no server render, and therefore none of our gates. `Clear-Site-Data: "cache"`
// used to cover this and was removed for costing ~25s of every logout.
//
// So this test is not about the component (bfcache-guard.test.tsx covers its behaviour). It is about the
// MOUNT: if someone deletes `<BfcacheGuard />` from the layout, every guard unit test still passes, and Back
// after logout silently repaints a signed-in page again. This is the test that goes red instead.
//
// It deliberately does NOT mock the guard and assert "was rendered" — a mock would prove only that a mock was
// called. It renders the REAL layout with the REAL guard and drives the REAL browser event, so the only way
// it can pass is if a live `pageshow` listener is actually attached by rendering this layout.

const reload = vi.fn();

beforeEach(() => {
  reload.mockClear();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload },
  });
});

function firePageShow(persisted: boolean) {
  const event = new Event("pageshow") as Event & { persisted?: boolean };
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

describe("RootLayout", () => {
  it("mounts the bfcache guard, so a restored page is sent back to the server", () => {
    render(<RootLayout>{null}</RootLayout>);

    firePageShow(true);

    expect(reload).toHaveBeenCalledOnce();
  });

  it("does not reload on an ordinary page load", () => {
    render(<RootLayout>{null}</RootLayout>);

    firePageShow(false);

    expect(reload).not.toHaveBeenCalled();
  });

  it("renders its children", () => {
    const { getByTestId } = render(
      <RootLayout>
        <div data-testid="page" />
      </RootLayout>,
    );
    expect(getByTestId("page")).toBeInTheDocument();
  });
});
