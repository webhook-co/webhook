import { describe, expect, it, vi } from "vitest";

const redirect = vi.fn((url: string) => {
  throw new Error(`NEXT_REDIRECT:${url}`);
});
vi.mock("next/navigation", () => ({ redirect: (url: string) => redirect(url) }));

import MovedCredentials from "./page";

// API keys & devices moved to the top-level /credentials. The old /settings/credentials path must not 404 —
// it permanently redirects, so existing bookmarks and links keep working.
describe("/settings/credentials (moved)", () => {
  it("redirects to the new top-level /credentials", () => {
    expect(() => MovedCredentials()).toThrow("NEXT_REDIRECT:/credentials");
    expect(redirect).toHaveBeenCalledWith("/credentials");
  });
});
