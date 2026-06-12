import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/**
 * Merge class names, resolving Tailwind conflicts.
 *
 * `clsx` handles conditional/array/object inputs; `twMerge` makes the last
 * conflicting utility win (so a caller's `className` can override a primitive's
 * defaults). Every primitive composes its classes through this.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
