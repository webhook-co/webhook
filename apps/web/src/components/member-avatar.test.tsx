import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { MemberAvatar } from "./member-avatar";

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
  // @ts-expect-error — restore jsdom's own definitions.
  delete HTMLImageElement.prototype.complete;
  // @ts-expect-error — ditto.
  delete HTMLImageElement.prototype.naturalWidth;
});

const img = () => document.querySelector("img");

describe("MemberAvatar", () => {
  it("draws initials underneath from the first paint (never an empty frame)", () => {
    render(<MemberAvatar name="Dana Kessler" email="d@e.test" slug="acme" userId="u1" />);
    expect(screen.getByText("DK")).toBeInTheDocument();
  });

  it("points at the membership-gated route built from the slug + user id (both encoded)", () => {
    render(<MemberAvatar name="Dana" email="d@e.test" slug="a b" userId="u/1" />);
    expect(img()).toHaveAttribute("src", "/api/org/a%20b/member-avatar/u%2F1");
  });

  it("falls back to initials when the avatar 404s after hydration", () => {
    render(<MemberAvatar name="Dana Kessler" email="d@e.test" slug="acme" userId="u1" />);
    fireEvent.error(img()!);
    expect(img()).toBeNull();
    expect(screen.getByText("DK")).toBeInTheDocument();
  });

  it("drops an image that ALREADY failed before hydration (mount-time zero-width check)", () => {
    makeImagesReportAlreadyFailed();
    render(<MemberAvatar name="Dana Kessler" email="d@e.test" slug="acme" userId="u1" />);
    expect(img()).toBeNull();
    expect(screen.getByText("DK")).toBeInTheDocument();
  });
});
