// PromoMaster — the promo film's top-level composition (brief §2).
//
// One <AbsoluteFill> composing the film's scenes as time-shifted
// <Sequence from={...} durationInFrames={...}> blocks, per the §5 frame table.
// The full film is built here: Act I (S1–S5, 0–360), Act II (S6–S11, 360–900),
// Act III (S12–S17, 900–1560), and Act IV (S18–S20, 1560–1800) — 1800 frames.
// The AbsoluteFill base is dark (--term-bg) for the dark terminal acts
// (S1–S5, S10–S16); the light acts (S6–S9 dashboard, S18–S20 close) each paint
// their own off-white base via <DotsBackground theme="light">, which covers the
// dark base full-frame — so no base switch is needed here, the scenes compose
// directly.
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
import { S12 } from "./scenes/S12";
import { S13 } from "./scenes/S13";
import { S14 } from "./scenes/S14";
import { S15 } from "./scenes/S15";
import { S16 } from "./scenes/S16";
import { S17 } from "./scenes/S17";
import { S18 } from "./scenes/S18";
import { S19 } from "./scenes/S19";
import { S20 } from "./scenes/S20";
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

      {/* ACT III — SURFACES → AGENT ERA (frames 900–1560). Dark throughout: the
          same event across four surfaces (S12), the turn (S13), the agent
          subscribes + parks (S14–S15), the wake / money-frame #3 (S16), and the
          forged-event stop + scoped-read-vs-reroute close (S17). */}
      <Sequence from={900} durationInFrames={120}>
        <S12 format={format} />
      </Sequence>
      <Sequence from={1020} durationInFrames={90}>
        <S13 format={format} />
      </Sequence>
      <Sequence from={1110} durationInFrames={120}>
        <S14 format={format} />
      </Sequence>
      <Sequence from={1230} durationInFrames={120}>
        <S15 format={format} />
      </Sequence>
      <Sequence from={1350} durationInFrames={120}>
        <S16 format={format} />
      </Sequence>
      <Sequence from={1470} durationInFrames={90}>
        <S17 format={format} />
      </Sequence>

      {/* ACT IV — CLOSE (frames 1560–1800). The light page: the hero headline
          resolves (S18), the signature line + wordmark land (S19), and the
          minimal off-white end card with the trust band holds (S20). Each Act IV
          scene paints its own off-white base via <DotsBackground theme="light">,
          covering the dark AbsoluteFill base full-frame. The film is complete
          (0–1800). */}
      <Sequence from={1560} durationInFrames={90}>
        <S18 format={format} />
      </Sequence>
      <Sequence from={1650} durationInFrames={90}>
        <S19 format={format} />
      </Sequence>
      <Sequence from={1740} durationInFrames={60}>
        <S20 format={format} />
      </Sequence>
    </AbsoluteFill>
  );
}
