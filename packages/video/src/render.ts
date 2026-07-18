// Node-only: uses @remotion/renderer (headless Chrome + FFmpeg); never import from an
// app/Worker bundle.
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import type { PromoProps } from "./compositions/Promo/schema";
import { webpackOverride } from "./webpack-override";

// Matches the `Promo` composition's `defaultProps` in Root.tsx — kept as a literal here (rather
// than a shared import) since Root.tsx doesn't export its `defaultProps` separately and adding
// an export just for this one caller would be over-engineering.
const inputProps: PromoProps = {
  headline: "Ship webhooks faster",
  tagline: "free, signed URLs — replay to localhost",
  theme: "dark",
};

async function main() {
  const entryPoint = path.resolve(import.meta.dirname, "index.ts");
  const serveUrl = await bundle({ entryPoint, webpackOverride });
  const composition = await selectComposition({ serveUrl, id: "Promo", inputProps });

  await renderStill({
    composition,
    serveUrl,
    output: "out/promo.png",
    frame: 90,
    inputProps,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: "out/promo.mp4",
    inputProps,
  });

  console.log("rendered out/promo.mp4 + out/promo.png");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
