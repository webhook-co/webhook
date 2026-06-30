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

  it("falls back to a branded monogram for a provider with no clean mark (slack → 'SL')", () => {
    const { container } = render(<ProviderLogo slug="slack" />);
    expect(container.querySelector("svg")).toBeNull(); // no path mark
    expect(container.textContent).toBe("SL");
  });

  it("uses the first letters of multi-word names (microsoft_graph → 'MG')", () => {
    const { container } = render(<ProviderLogo slug="microsoft_graph" />);
    expect(container.textContent).toBe("MG");
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
