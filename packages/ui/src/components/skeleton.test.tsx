import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Skeleton, SkeletonText } from "./skeleton";

describe("Skeleton", () => {
  it("pulses, but stops for a reduced-motion preference", () => {
    const { container } = render(<Skeleton />);
    const el = container.firstElementChild!;
    expect(el.className).toContain("animate-pulse");
    // The block stays; only the motion is dropped — matching Spinner.
    expect(el.className).toContain("motion-reduce:animate-none");
  });

  // A skeleton is scaffolding. The CONTAINER announces "loading"; each shimmer announcing itself would make a
  // screen reader read "blank, blank, blank".
  it("is hidden from assistive tech", () => {
    const { container } = render(<Skeleton />);
    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
  });

  it("merges a caller's className rather than dropping it", () => {
    const { container } = render(<Skeleton className="h-8 w-40" />);
    expect(container.firstElementChild!.className).toContain("h-8");
    expect(container.firstElementChild!.className).toContain("w-40");
  });
});

describe("SkeletonText", () => {
  it("renders the requested number of lines", () => {
    const { container } = render(<SkeletonText lines={4} />);
    expect(container.querySelectorAll("[aria-hidden]")).toHaveLength(4);
  });

  // The last line is short, the way a real paragraph ends — so the placeholder reads as text, not a grid of
  // identical bars.
  it("ends on a short line", () => {
    const { container } = render(<SkeletonText lines={3} />);
    const lines = [...container.querySelectorAll("[aria-hidden]")];
    expect(lines.at(-1)!.className).toContain("w-2/3");
    expect(lines[0]!.className).toContain("w-full");
  });

  it("does not announce itself either", () => {
    render(<SkeletonText lines={2} />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});
