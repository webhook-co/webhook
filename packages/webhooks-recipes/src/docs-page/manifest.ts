// Turns a provider MDX page into the entry `scripts/content-dup-guard.mjs` compares.
//
// What gets compared is the deliberate part. Fenced code blocks are STRIPPED: the CLI/API/TypeScript
// register snippets are identical across providers apart from the slug, so feeding them to a shingle
// comparison would make every page look more similar to every other — it would invert the guard it is
// meant to feed. Headings and inline code are KEPT: a header name like `x-mailgun-signature` is real,
// visible, provider-specific substance and should count toward the page carrying its own weight.

export interface ManifestPage {
  readonly id: string;
  readonly host: string;
  readonly path: string;
  readonly intent: string;
  /** Brand name — the guard neutralizes it before shingling, else identical templates look distinct. */
  readonly name: string;
  /** Signature header — likewise neutralized, for the same reason. */
  readonly header: string;
  readonly text: string;
  /**
   * False for the hand-authored pages. They are in the manifest so a generated page can be caught
   * duplicating one (calendly's recipe is byte-identical to stripe's), but their length is an
   * editorial choice, so they sit out the generated-content word floor — and only that.
   */
  readonly generated: boolean;
}

/** Extract the human-visible prose from an MDX page. */
export function mdxToText(mdx: string): string {
  let s = mdx;
  s = s.replace(/^---\n[\s\S]*?\n---\n/, " "); // frontmatter
  s = s.replace(/```[\s\S]*?```/g, " "); // fenced code (boilerplate by design)
  s = s.replace(/\{\/\*[\s\S]*?\*\/\}/g, " "); // MDX comments
  s = s.replace(/<\/?[A-Za-z][^>]*>/g, " "); // JSX/component tags, prose inside kept
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // images
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links → link text
  s = s.replace(/^#{1,6}\s+/gm, ""); // heading markers, text kept
  s = s.replace(/^\s*[-*+]\s+/gm, ""); // list markers
  s = s.replace(/[`*_>|]/g, " "); // inline emphasis/code marks, text kept
  return s.replace(/\s+/g, " ").trim();
}

export function manifestEntry(input: {
  slug: string;
  displayName: string;
  signatureHeader: string | null;
  mdx: string;
  generated?: boolean;
}): ManifestPage {
  return {
    id: `docs:${input.slug}`,
    host: "docs",
    path: `/providers/${input.slug}`,
    intent: "reference",
    name: input.displayName,
    header: input.signatureHeader ?? "",
    text: mdxToText(input.mdx),
    generated: input.generated ?? true,
  };
}
