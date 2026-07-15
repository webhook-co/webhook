import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { orgLogoVersion } from "@/lib/org-logo-version";

import { OrgAvatar } from "./org-avatar";

const logo = () => document.querySelector('img[src^="/api/org-logo/"]');

afterEach(() => {
  cleanup();
  orgLogoVersion.__resetForTests();
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
