/**
 * `@webhook-co/ui` — the webhook.co design system.
 *
 * Tokens (the typed source of truth), motion conventions, the `cn` class merger, and
 * the React primitives. Styles live under `@webhook-co/ui/styles/*` and are wired into
 * the Tailwind theme by the consuming app. See the package README for principles and
 * usage.
 *
 * Re-exports are explicit (no `export *`) so bundlers resolve every name reliably.
 */

// ── tokens ──────────────────────────────────────────────────────────────────
export { ink, type InkStop } from "./tokens/ink";
export { light, dark, type SemanticTheme, type StateName } from "./tokens/semantic";
export { fontFamily, fontSize, fontWeight, tracking, leading } from "./tokens/typography";
export { space, container } from "./tokens/spacing";
export { radius, shadowLight, shadowDark, focusRing } from "./tokens/elevation";
export { duration, easing, cubicBezier, type DurationName, type EasingName } from "./tokens/motion";
export { CSS_VAR_PREFIX, renderThemeCss } from "./tokens/theme";

// ── motion conventions ──────────────────────────────────────────────────────
export {
  productTransition,
  marketingTransition,
  exitTransition,
  fadeInUp,
  fade,
  stagger,
  prefersReducedMotion,
} from "./motion/index";

// ── components ──────────────────────────────────────────────────────────────
export { Button, buttonVariants, type ButtonProps } from "./components/button";
export { IconButton, type IconButtonProps } from "./components/icon-button";
export { Input, Label, type InputProps, type LabelProps } from "./components/input";
export { Field, type FieldProps } from "./components/field";
export { Spinner, type SpinnerProps } from "./components/spinner";
export {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
} from "./components/card";
export { Badge, badgeVariants, type BadgeProps } from "./components/badge";
export {
  StatusPill,
  deliveryStatusTone,
  type StatusPillProps,
  type StatusTone,
  type DeliveryStatus,
} from "./components/status";
export { Mark, Wordmark, type MarkProps, type WordmarkProps } from "./components/mark";

// ── utilities ───────────────────────────────────────────────────────────────
export { cn } from "./lib/cn";
