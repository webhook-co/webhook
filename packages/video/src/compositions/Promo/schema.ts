import { z } from "zod";

// A plain zod validator — used both by Remotion's `<Composition schema={...}>` (Studio's
// visual props editor) and, later, by Task 9's render-batch tool via `promoSchema.parse`.
// See task-6-report.md for why `schema` on <Composition> is included/omitted.
export const promoSchema = z.object({
  headline: z.string().min(1),
  tagline: z.string().min(1),
  theme: z.enum(["dark", "light"]).default("dark"),
});

export type PromoProps = z.infer<typeof promoSchema>;
