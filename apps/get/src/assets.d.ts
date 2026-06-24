// install.sh is imported as a Text module (wrangler `rules: [{ type: "Text" }]`), so TypeScript resolves it
// to this ambient declaration rather than reading the file — its string contents are the default export.
declare module "*.sh" {
  const content: string;
  export default content;
}
