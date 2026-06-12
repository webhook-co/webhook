/**
 * Regenerate `src/styles/theme.css` from the typed tokens.
 *
 * Run via `pnpm --filter @webhook-co/ui gen:theme`. The drift test
 * (`src/tokens/theme.test.ts`) fails CI if the committed file ever diverges from this
 * output, so this script and the tokens stay the one source of truth.
 */

import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { renderThemeCss } from "../src/tokens/theme";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../src/styles/theme.css");

writeFileSync(target, renderThemeCss(), "utf8");
console.log(`wrote ${target}`);
