// Node-only: uses @remotion/renderer (headless Chrome + FFmpeg); never import from an
// app/Worker bundle.
import path from "node:path";
import { bundle } from "@remotion/bundler";
import { renderMedia, renderStill, selectComposition } from "@remotion/renderer";
import { webpackOverride } from "./webpack-override";

async function main() {
  const entryPoint = path.resolve(import.meta.dirname, "index.ts");
  const serveUrl = await bundle({ entryPoint, webpackOverride });
  // No inputProps here: selectComposition resolves the `Promo` composition's own
  // `defaultProps` (the inline literal on <Composition> in Root.tsx), which stays the
  // single source of truth so Studio's visual props editor can still write back to it.
  const composition = await selectComposition({ serveUrl, id: "Promo" });

  await renderStill({
    composition,
    serveUrl,
    output: "out/promo.png",
    frame: 90,
  });

  await renderMedia({
    composition,
    serveUrl,
    codec: "h264",
    outputLocation: "out/promo.mp4",
  });

  console.log("rendered out/promo.mp4 + out/promo.png");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
