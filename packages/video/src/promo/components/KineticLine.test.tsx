import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { KineticLineView } from "./KineticLine";

// KineticLine's real branching logic is the "big line gets tight tracking"
// rule (brief §3.2) plus the progress→opacity/translateY mapping — test the
// pure View directly (mirrors the HeadlineScene/BrandLockup split; the spring
// itself is Remotion's own tested primitive, driven with the brief §3.4 config
// by the thin wrapper).
describe("KineticLineView", () => {
  it("starts fully transparent, offset by 12px, before the spring begins (progress=0)", () => {
    const { getByText } = render(
      <KineticLineView text="Watch it land." size={84} weight={600} align="center" progress={0} />,
    );
    const el = getByText("Watch it land.");
    expect(el.style.opacity).toBe("0");
    expect(el.style.transform).toBe("translateY(12px)");
  });

  it("settles fully visible at translateY(0) once the spring completes (progress=1)", () => {
    const { getByText } = render(
      <KineticLineView text="Watch it land." size={84} weight={600} align="center" progress={1} />,
    );
    const el = getByText("Watch it land.");
    expect(el.style.opacity).toBe("1");
    expect(el.style.transform).toBe("translateY(0px)");
  });

  it("clamps opacity/translateY rather than overshooting past the settle for progress > 1", () => {
    const { getByText } = render(
      <KineticLineView
        text="Watch it land."
        size={84}
        weight={600}
        align="center"
        progress={1.5}
      />,
    );
    const el = getByText("Watch it land.");
    expect(el.style.opacity).toBe("1");
    expect(el.style.transform).toBe("translateY(0px)");
  });

  it("applies the tight -0.02em tracking to a big (hero-scale) line", () => {
    const { getByText } = render(
      <KineticLineView text="Watch it land." size={84} weight={600} align="center" progress={1} />,
    );
    expect(getByText("Watch it land.").style.letterSpacing).toBe("-0.02em");
  });

  it("keeps normal tracking on a caption-scale (non-big) line", () => {
    const { getByText } = render(
      <KineticLineView
        text="captured durably before it acks"
        size={40}
        weight={400}
        align="left"
        progress={1}
      />,
    );
    expect(getByText("captured durably before it acks").style.letterSpacing).toBe("normal");
  });

  it("passes the align prop straight through as CSS text-align", () => {
    const { getByText } = render(
      <KineticLineView text="webhook.co" size={40} weight={500} align="right" progress={1} />,
    );
    expect(getByText("webhook.co").style.textAlign).toBe("right");
  });
});
