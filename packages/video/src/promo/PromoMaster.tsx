// PromoMaster — the promo film's top-level composition (brief §2).
//
// One <AbsoluteFill> composing the film's scenes as time-shifted
// <Sequence from={...} durationInFrames={...}> blocks, per the §5 frame table.
// Act I (S1–S5, frames 0–360) and Act II (S6–S11, frames 360–900) are built
// here. The AbsoluteFill base is dark (--term-bg) for the dark terminal acts
// (S1–S5, S10–S11); the light dashboard acts (S6–S9) each paint their own
// off-white base via <DotsBackground theme="light">, which covers the dark base
// full-frame — so no base switch is needed here, the scenes compose directly.
// Each scene reads useCurrentFrame() as 0 at its own start because the enclosing
// <Sequence> time-shifts it, so scenes are authored in scene-local frames.
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
import { S6 } from "./scenes/S6";
import { S7 } from "./scenes/S7";
import { S8 } from "./scenes/S8";
import { S9 } from "./scenes/S9";
import { S10 } from "./scenes/S10";
import { S11 } from "./scenes/S11";
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

      {/* ACT II — VERIFY & TRUST (frames 360–900). S6–S9 are the light dashboard
          scenes; S10–S11 return to the dark terminal. */}
      <Sequence from={360} durationInFrames={90}>
        <S6 format={format} />
      </Sequence>
      <Sequence from={450} durationInFrames={90}>
        <S7 format={format} />
      </Sequence>
      <Sequence from={540} durationInFrames={90}>
        <S8 format={format} />
      </Sequence>
      <Sequence from={630} durationInFrames={90}>
        <S9 format={format} />
      </Sequence>
      <Sequence from={720} durationInFrames={90}>
        <S10 format={format} />
      </Sequence>
      <Sequence from={810} durationInFrames={90}>
        <S11 format={format} />
      </Sequence>

      {/* TODO: ACT III–IV — S12–S20 (frames 900–1800) to be added in later acts.
          Act III returns to dark (surfaces → the wake); Act IV closes on light.
          The master composition already reserves the full 1800-frame duration. */}
    </AbsoluteFill>
  );
}
