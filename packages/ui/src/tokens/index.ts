/**
 * Design tokens — the typed source of truth for the webhook.co visual system.
 *
 * Everything downstream (the Tailwind theme, React primitives, the animation engine,
 * and non-React surfaces that need a color or a duration) reads from here. The runtime
 * CSS variables in `styles/theme.css` are generated from these values; see
 * {@link ./theme} and the drift test that keeps them honest.
 */

export { ink, type InkStop } from "./ink";
export { light, dark, type SemanticTheme, type StateName } from "./semantic";
export { fontFamily, fontSize, fontWeight, tracking, leading } from "./typography";
export { space, container } from "./spacing";
export { radius, shadowLight, shadowDark, focusRing } from "./elevation";
export { duration, easing, cubicBezier, type DurationName, type EasingName } from "./motion";
export { CSS_VAR_PREFIX, renderThemeCss } from "./theme";
