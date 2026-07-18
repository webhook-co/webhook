// fonts.ts — the promo film's two typefaces, loaded via @remotion/google-fonts.
//
// Brief §3.2 / §10.2: Inter (OFL) for kinetic headlines + captions; JetBrains
// Mono (OFL) for EVERY terminal / UI / code / event string. Never substitute a
// proportional font for a real product string. Both subpaths were verified to
// exist in the installed @remotion/google-fonts (Inter → family "Inter";
// JetBrainsMono → family "JetBrains Mono").
//
// Importing this module registers both fonts as a side effect. Downstream scene
// components import the { inter, mono } family strings and set them via inline
// `fontFamily` styles.

import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { loadFont as loadMono } from "@remotion/google-fonts/JetBrainsMono";

// Weights used across the film: 400 (captions/body), 500 (badges/labels),
// 600 (headlines). latin subset only — every on-screen string is ASCII.
const { fontFamily: inter } = loadInter("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

const { fontFamily: mono } = loadMono("normal", {
  weights: ["400", "500", "600"],
  subsets: ["latin"],
});

export { inter, mono };
