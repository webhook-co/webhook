import { pageMetadata } from "@/app/metadata";
import { TutorialPage } from "@/components/marketing/tutorial/tutorial-page";
import { getTutorial, tutorialPath } from "@/lib/tutorials";

// Thin per-route wrapper. The app has no dynamic segments by convention — every page exports a static
// `metadata` const, and the per-page tests import { Page, metadata } directly — so each tutorial gets
// its own file and the shared component carries the layout.
const SLUG = "airtable";
const tutorial = getTutorial(SLUG)!;

export const metadata = pageMetadata({
  path: tutorialPath(SLUG),
  title: tutorial.title,
  description: tutorial.description,
  ogType: "article",
});

export default function Page() {
  return <TutorialPage tutorial={tutorial} />;
}
