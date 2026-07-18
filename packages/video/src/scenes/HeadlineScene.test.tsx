import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { HeadlineSceneView } from "./HeadlineScene";

// HeadlineSceneView is the pure presentational half of the adapter (same split as
// BrandLockupView): it takes the animation value as a prop instead of reading Remotion's
// useCurrentFrame(), so it renders like any other React component in jsdom.
describe("HeadlineSceneView", () => {
  it("renders the headline and tagline text", () => {
    render(
      <HeadlineSceneView
        headline="Ship webhooks faster"
        tagline="free, signed URLs — replay to localhost"
        enter={1}
      />,
    );

    expect(screen.getByText("Ship webhooks faster")).toBeTruthy();
    expect(screen.getByText("free, signed URLs — replay to localhost")).toBeTruthy();
  });

  it("clamps opacity to the fully-visible state once enter reaches 1", () => {
    render(<HeadlineSceneView headline="Headline" tagline="Tagline" enter={1} />);
    const headline = screen.getByText("Headline").closest("[style]") as HTMLElement | null;
    expect(headline).not.toBeNull();
    expect(headline?.style.opacity).toBe("1");
  });

  it("starts fully transparent before the entrance spring begins", () => {
    render(<HeadlineSceneView headline="Headline" tagline="Tagline" enter={0} />);
    const headline = screen.getByText("Headline").closest("[style]") as HTMLElement | null;
    expect(headline?.style.opacity).toBe("0");
  });
});
