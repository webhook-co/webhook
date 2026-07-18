// PromoMaster — the promo film's top-level composition (brief §2).
//
// One <AbsoluteFill> composing the film's scenes as time-shifted
// <Sequence from={...} durationInFrames={...}> blocks, per the §5 frame table.
// Act I (S1–S5, frames 0–360) is built here; the base background is dark
// (--term-bg) for the dark terminal acts. Each scene reads useCurrentFrame() as
// 0 at its own start because the enclosing <Sequence> time-shifts it, so scenes
// are authored in scene-local frames.
//
// `format` is threaded down so scenes can switch layout / scale type for the
// 9:16 cut (brief §8); the 16:9 master registers it via defaultProps in Root.

import { AbsoluteFill, Sequence } from "remotion";

// Importing the promo fonts module once here registers Inter + JetBrains Mono
// as a side effect, high in the tree (the scenes also import it transitively).
import "./fonts";
import { S1 } from "./scenes/S1";
import { S2 } from "./scenes/S2";
import { S3 } from "./scenes/S3";
import { S4 } from "./scenes/S4";
import { S5 } from "./scenes/S5";
import { colors } from "./tokens";
import type { Format } from "./tokens";

export interface PromoMasterProps {
  format?: Format;
}

export function PromoMaster({ format = "16x9" }: PromoMasterProps) {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.termBg }}>
      {/* ACT I — LAND (frames 0–360). */}
      <Sequence from={0} durationInFrames={90}>
        <S1 format={format} />
      </Sequence>
      <Sequence from={90} durationInFrames={60}>
        <S2 format={format} />
      </Sequence>
      <Sequence from={150} durationInFrames={60}>
        <S3 format={format} />
      </Sequence>
      <Sequence from={210} durationInFrames={90}>
        <S4 format={format} />
      </Sequence>
      <Sequence from={300} durationInFrames={60}>
        <S5 format={format} />
      </Sequence>

      {/* TODO: ACT II–IV — S6–S20 (frames 360–1800) to be added in later acts.
          Act II/IV cut to the light --page-bg surface; Act III returns to dark.
          The master composition already reserves the full 1800-frame duration. */}
    </AbsoluteFill>
  );
}
