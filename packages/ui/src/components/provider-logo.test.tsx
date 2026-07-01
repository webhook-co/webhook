import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ProviderLogo } from "./provider-logo";

describe("ProviderLogo", () => {
  it("renders the official single-path mark for a provider that has one (stripe)", () => {
    const { container } = render(<ProviderLogo slug="stripe" title="Stripe" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute("role")).toBe("img");
    expect(svg!.getAttribute("aria-label")).toBe("Stripe");
    const path = svg!.querySelector("path");
    expect(path).not.toBeNull();
    expect(path!.getAttribute("d")!.length).toBeGreaterThan(10);
  });

  it("paints the same-origin favicon over the tile for a logo-less brand with a domain (slack)", () => {
    const { container } = render(<ProviderLogo slug="slack" />);
    expect(container.querySelector("svg")).toBeNull(); // no vector mark
    const span = container.querySelector("span")!;
    // favicon proxied same-origin (no third-party host) → satisfies img-src 'self'
    expect(span.style.backgroundImage).toBe('url("/api/provider-icon?domain=slack.com")');
    expect(span.style.backgroundSize).toBe("cover");
    // the monogram initials are still the base layer → shown if the favicon fails/doesn't paint
    expect(container.textContent).toBe("SL");
  });

  it("uses the first letters of multi-word names as the tile fallback (microsoft_graph → 'MG')", () => {
    const { container } = render(<ProviderLogo slug="microsoft_graph" />);
    expect(container.textContent).toBe("MG");
    expect(container.querySelector("span")!.style.backgroundImage).toContain(
      "domain=microsoft.com",
    );
  });

  it("renders a bare monogram (no favicon) for an unknown slug with no mark and no domain", () => {
    const { container } = render(<ProviderLogo slug="some_new_provider" />);
    expect(container.querySelector("svg")).toBeNull();
    const span = container.querySelector("span")!;
    expect(span.style.backgroundImage).toBe(""); // no domain → no favicon layer
    expect(container.textContent).toBe("SN"); // "Some New" → first letters of first two words
  });

  it("skips the favicon (monogram only) when faviconFallback is false (static host, no /api route)", () => {
    const { container } = render(<ProviderLogo slug="slack" faviconFallback={false} />);
    const span = container.querySelector("span")!;
    expect(span.style.backgroundImage).toBe(""); // no favicon request emitted
    expect(container.textContent).toBe("SL");
  });

  it("renders nothing for a null provider (the caller shows the placeholder)", () => {
    const { container } = render(<ProviderLogo slug={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("is decorative (aria-hidden) when no title is given", () => {
    const { container } = render(<ProviderLogo slug="stripe" />);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});
