import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UserAvatar } from "./user-avatar";

/**
 * Force the <img> to behave as one that ALREADY FAILED before React could attach its listener — which is the
 * real, common case in the browser and the one jsdom cannot produce on its own (it never loads images).
 *
 * A finished-but-zero-width image is a failed image.
 */
function makeImagesReportAlreadyFailed() {
  Object.defineProperty(HTMLImageElement.prototype, "complete", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(HTMLImageElement.prototype, "naturalWidth", {
    configurable: true,
    get: () => 0,
  });
}

afterEach(() => {
  // @ts-expect-error — restore jsdom's own definitions by deleting the overrides.
  delete HTMLImageElement.prototype.complete;
  // @ts-expect-error — ditto.
  delete HTMLImageElement.prototype.naturalWidth;
});

const avatar = () => document.querySelector('img[src="/api/avatar"]');

describe("UserAvatar", () => {
  it("draws initials underneath from the very first paint, so there is never an empty frame", () => {
    render(<UserAvatar name="Dana Kessler" email="dana@acme.co" />);
    expect(screen.getByText("DK")).toBeInTheDocument();
  });

  it("asks OUR origin for the image — never a third party", () => {
    render(<UserAvatar name="Dana Kessler" email="dana@acme.co" />);

    // Same-origin. The CSP is `img-src 'self'`, and a hotlinked Gravatar would beacon the user's IP and
    // referring page to a third party on every single page view.
    expect(avatar()).toHaveAttribute("src", "/api/avatar");
  });

  it("cache-busts with ?v= when a version is given — so a freshly uploaded avatar shows at once", () => {
    render(<UserAvatar name="Dana Kessler" email="dana@acme.co" version={7} />);
    // The serve route is input-less (max-age=60), so the ONLY way to force the browser off its cached copy
    // right after an upload is to change the URL. A non-zero version does exactly that.
    expect(document.querySelector('img[src="/api/avatar?v=7"]')).not.toBeNull();
    expect(avatar()).toBeNull(); // no bare /api/avatar — the versioned URL replaced it
  });

  it("drops the image when it fails after hydration", () => {
    render(<UserAvatar name="Dana Kessler" email="dana@acme.co" />);

    fireEvent.error(avatar()!);

    expect(avatar()).toBeNull();
    expect(screen.getByText("DK")).toBeInTheDocument();
  });

  // THE BUG THIS COMPONENT SHIPPED WITH, and the reason `onError` alone is not enough.
  //
  // The <img> is SERVER-RENDERED, so the browser begins loading it during HTML parse — long before React
  // hydrates and attaches the onError listener. For the common case (a user with no Gravatar) the request 404s
  // almost immediately, the error event fires into the void, and the handler that arrives a moment later is
  // never called. The broken-image glyph then sits on the page forever, on top of the initials.
  //
  // It was invisible to the suite: jsdom does not load images, so `onError` never fires there either way and
  // everything stayed green. It took opening the page. This test manufactures the already-failed element that
  // jsdom will not produce, and demands the component notice on mount.
  it("notices an image that ALREADY FAILED before React could listen", () => {
    makeImagesReportAlreadyFailed();

    render(<UserAvatar name="Dana Kessler" email="dana@acme.co" />);

    expect(avatar()).toBeNull();
    expect(screen.getByText("DK")).toBeInTheDocument();
  });

  it("falls back to the email when there is no name to take initials from", () => {
    render(<UserAvatar name="" email="dana@acme.co" />);
    expect(screen.getByText("DA")).toBeInTheDocument();
  });
});
