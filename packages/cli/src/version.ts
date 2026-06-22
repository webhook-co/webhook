// The CLI version, single-sourced (app.ts re-exports it; doctor reads it). Kept in sync with
// package.json; the distribution epic will stamp the real value at build time. Until then it is the
// placeholder "0.0.0", which `doctor` surfaces as a `(dev)` build (ADR-0041 / Open-Q3).
export const VERSION = "0.0.0";
