// Placeholder entrypoint for the @webhook-co/video scaffold (Task 1 of the Remotion
// video pipeline plan). Task 2+ replaces this with the actual composition/render
// source. It exists solely so `tsc --noEmit` has an input file to check: the repo's
// pre-commit hook runs `turbo run typecheck` across every workspace package, and an
// `include` pattern matching zero files is a hard TS18003 error, not a silent pass.
export {};
