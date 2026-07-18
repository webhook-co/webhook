import type { WebpackOverrideFn } from "@remotion/bundler";

export const webpackOverride: WebpackOverrideFn = (current) => ({
  ...current,
  resolve: { ...current.resolve, symlinks: true },
});
