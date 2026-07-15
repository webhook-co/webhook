import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { orgLogoVersion } from "@/lib/org-logo-version";

import { OrgAvatar } from "./org-avatar";

const logo = () => document.querySelector('img[src^="/api/org-logo/"]');

/**
 * Force the <img> to behave as one that ALREADY FAILED before React could attach onError — the real, common
 * case (a logo-less org 404s during HTML parse, before hydration). jsdom never loads images, so we simulate
 * a finished-but-zero-width image, which is a failed one. Mirrors user-avatar.test.
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
  cleanup();
  orgLogoVersion.__resetForTests();
  // @ts-expect-error — restore jsdom's own definitions by deleting the overrides.
  delete HTMLImageElement.prototype.complete;
  // @ts-expect-error — ditto.
  delete HTMLImageElement.prototype.naturalWidth;
});

describe("OrgAvatar", () => {
  it("renders the generated initial tile from the first paint", () => {
    render(<OrgAvatar name="Acme" />);
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("does NOT fetch a logo when given no slug (generated tile only)", () => {
    render(<OrgAvatar name="Acme" />);
    expect(logo()).toBeNull();
  });

  it("attempts the org logo from OUR slug-scoped route when given a slug", () => {
    render(<OrgAvatar name="Acme" slug="acme" />);
    expect(logo()).toHaveAttribute("src", "/api/org-logo/acme");
  });

  it("falls back to the tile when the logo 404s (org has none)", () => {
    render(<OrgAvatar name="Acme" slug="acme" />);
    fireEvent.error(logo()!);
    expect(logo()).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  // THE pre-hydration case: the server-rendered <img> 404s during parse, before React attaches onError — so
  // the mount-time complete && naturalWidth===0 check is the only thing that drops it to the tile. Deleting
  // that effect would leave onError-only coverage green while a torn-image glyph showed in the browser.
  it("drops a logo that ALREADY failed before hydration (mount-time check, not just onError)", () => {
    makeImagesReportAlreadyFailed();
    render(<OrgAvatar name="Acme" slug="acme" />);
    expect(logo()).toBeNull();
    expect(screen.getByText("A")).toBeInTheDocument();
  });

  it("cache-busts every org avatar with ?v= when the shared version bumps (a fresh upload)", () => {
    render(<OrgAvatar name="Acme" slug="acme" />);
    expect(logo()).toHaveAttribute("src", "/api/org-logo/acme");

    act(() => orgLogoVersion.bump());

    expect(document.querySelector('img[src^="/api/org-logo/acme?v="]')).not.toBeNull();
  });

  it("url-encodes the slug (defensive — slugs are constrained, but never build a raw URL)", () => {
    render(<OrgAvatar name="Acme" slug="a b" />);
    expect(logo()).toHaveAttribute("src", "/api/org-logo/a%20b");
  });
});
