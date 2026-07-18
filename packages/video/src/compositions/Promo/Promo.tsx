import { AbsoluteFill, Series } from "remotion";

import { BrandLockup } from "../../scenes/BrandLockup";
import { HeadlineScene } from "../../scenes/HeadlineScene";
import { geist } from "../../fonts";
import type { PromoProps } from "./schema";

/** Intro: the brand lockup, reused unchanged from Task 5. */
export const INTRO_DURATION_IN_FRAMES = 45;
/** Payoff: the headline + tagline scene. */
export const HEADLINE_DURATION_IN_FRAMES = 120;

/** Single source of truth for the composition's total length — Root.tsx imports this so the
 * registered `durationInFrames` can never drift out of sync with the `<Series>` below. */
export const PROMO_DURATION_IN_FRAMES = INTRO_DURATION_IN_FRAMES + HEADLINE_DURATION_IN_FRAMES;

/**
 * The parametrized product-promo composition: an intro `BrandLockup` (reused unchanged)
 * followed by a `HeadlineScene` carrying the caller-supplied copy, composed with `<Series>`
 * so each scene owns its own frame-local motion.
 */
export const Promo = ({ headline, tagline, theme }: PromoProps) => (
  <AbsoluteFill className="bg-surface" data-theme={theme} style={{ fontFamily: geist.fontFamily }}>
    <Series>
      <Series.Sequence durationInFrames={INTRO_DURATION_IN_FRAMES}>
        <BrandLockup />
      </Series.Sequence>
      <Series.Sequence durationInFrames={HEADLINE_DURATION_IN_FRAMES}>
        <HeadlineScene headline={headline} tagline={tagline} />
      </Series.Sequence>
    </Series>
  </AbsoluteFill>
);
