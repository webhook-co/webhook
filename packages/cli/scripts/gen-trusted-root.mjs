#!/usr/bin/env node
// Fetch the sigstore public-good trusted root (via TUF, once) and embed it as src/trusted-root.json so the
// CLI verifies provenance WITHOUT a runtime TUF fetch / the seeds.json that `bun --compile` drops. Re-run
// this if the sigstore trust root rotates (rare). DIST-7 follow-up.
import { writeFileSync } from "node:fs";
import { TrustedRoot } from "@sigstore/protobuf-specs";
import { getTrustedRoot } from "@sigstore/tuf";
const root = await getTrustedRoot();
const out = new URL("../src/trusted-root.json", import.meta.url);
writeFileSync(out, JSON.stringify(TrustedRoot.toJSON(root), null, 2) + "\n");
console.log("✓ embedded src/trusted-root.json");
