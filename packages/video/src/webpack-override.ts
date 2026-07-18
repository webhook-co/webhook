import type { WebpackOverrideFn } from "@remotion/bundler";
import { enableTailwind } from "@remotion/tailwind-v4";

export const webpackOverride: WebpackOverrideFn = (current) =>
  enableTailwind({ ...current, resolve: { ...current.resolve, symlinks: true } });
