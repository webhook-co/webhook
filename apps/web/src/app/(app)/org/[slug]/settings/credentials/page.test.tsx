import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  redirect: (url: string) => redirect(url),
}));

import MovedCredentials from "./page";

// API keys & devices moved to the top-level /credentials. The old /settings/credentials path must not 404 —
// it permanently redirects, so existing bookmarks and links keep working. Post-URL-move it must redirect
// WITHIN the org: a bare /credentials is not a route any more, so the stub would have traded a 404 for a 404.
describe("/settings/credentials (moved)", () => {
  it("redirects to the org's top-level /credentials, keeping the org in the URL", async () => {
    await expect(MovedCredentials({ params: Promise.resolve({ slug: "acme" }) })).rejects.toThrow(
      "NEXT_REDIRECT:/org/acme/credentials",
    );
    expect(redirect).toHaveBeenCalledWith("/org/acme/credentials");
  });
});
