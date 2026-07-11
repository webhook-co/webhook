import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mockMatchMedia } from "@/lib/test-utils";
import { axeComponent } from "@/test/axe";

import AcceptableUsePage from "./page";

describe("AcceptableUsePage", () => {
  beforeEach(() => {
    mockMatchMedia(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders the document title as the single h1", () => {
    render(<AcceptableUsePage />);
    expect(
      screen.getByRole("heading", { level: 1, name: /^acceptable use policy$/i }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  it("exposes a main landmark wired to the skip link", () => {
    render(<AcceptableUsePage />);
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("names the abuse vectors THIS product actually enables", () => {
    // Not a generic AUP. We accept arbitrary inbound data at a public URL and deliver it onward to a
    // customer-chosen destination — so the outbound side is the part that has to be spelled out.
    render(<AcceptableUsePage />);
    const body = (screen.getByRole("main").textContent ?? "").toLowerCase();
    expect(body).toContain("command-and-control");
    expect(body).toContain("open relay");
    expect(body).toContain("replay"); // outbound abuse via delivery/replay
    expect(body).toContain("authorised to");
  });

  it("reserves the RIGHT to investigate without promising a duty to monitor", () => {
    // The asymmetry is deliberate: we must be able to act on abuse, without implying we read payloads.
    render(<AcceptableUsePage />);
    const body = (screen.getByRole("main").textContent ?? "").toLowerCase();
    expect(body).toContain("right, but not the duty");
    expect(body).toContain("do not monitor");
  });

  it("disclaims PHI/PCI rather than silently accepting it", () => {
    render(<AcceptableUsePage />);
    const body = (screen.getByRole("main").textContent ?? "").toLowerCase();
    expect(body).toContain("hipaa");
    expect(body).toContain("pci dss");
    expect(body).toContain("we do not sign baas");
  });

  it("composes without axe violations (semantics)", async () => {
    const { container } = render(<AcceptableUsePage />);
    expect(await axeComponent(container)).toHaveNoViolations();
  }, 20000);
});
