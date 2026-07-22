import { pageMetadata } from "@/app/metadata";
import { ComparisonPage } from "@/components/marketing/comparison/comparison-page";
import { comparisonPath, getComparison } from "@/lib/comparisons";

// Thin per-route wrapper. The app has no dynamic segments by convention — every page exports a static
// `metadata` const, and `routes.test.ts` reconciles the manifest against the filesystem, so a
// `[slug]` directory would register as the literal route `/vs/[slug]` and fail that check.
const SLUG = "webhook-site";
const comparison = getComparison(SLUG)!;

export const metadata = pageMetadata({
  path: comparisonPath(SLUG),
  title: comparison.title,
  description: comparison.description,
  ogType: "article",
});

export default function Page() {
  return <ComparisonPage comparison={comparison} />;
}
