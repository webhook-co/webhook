import { beforeEach, describe, expect, it, vi } from "vitest";

const verifySession = vi.fn(async () => ({
  userId: "usr_1",
  orgId: "org_default",
  user: { name: "Dana", email: "dana@e.test", image: null },
}));
vi.mock("./session", async () => {
  const actual = await vi.importActual<typeof import("./session")>("./session");
  return { ...actual, verifySession: () => verifySession() };
});
vi.mock("next/navigation", () => ({
  useParams: () => ({ slug: "acme" }),
  redirect: vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`NEXT_PERMANENT_REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));
const listUserOrgs = vi.fn();
vi.mock("@webhook-co/db/orgs", () => ({
  listUserOrgs: (...a: unknown[]) => listUserOrgs(...a),
}));
vi.mock("./db", () => ({ withTenantDb: (fn: (app: unknown) => unknown) => fn({}) }));

import { requireActiveOrgAccess, requireOrgAccess } from "./org-access";
import { LOGIN_URL } from "./session";

const ALPHA = {
  orgId: "org_alpha",
  slug: "alpha",
  formerSlugs: [] as string[],
  name: "Alpha",
  role: "owner",
  status: "active",
  suspendedReason: null,
};
const BETA = {
  orgId: "org_beta",
  slug: "beta-corp",
  formerSlugs: ["beta-old", "beta-ancient"],
  name: "Beta",
  role: "member",
  status: "active",
  suspendedReason: null,
};
const SUSPENDED = {
  orgId: "org_susp",
  slug: "paused-co",
  formerSlugs: [] as string[],
  name: "Paused Co",
  role: "owner",
  status: "suspended",
  suspendedReason: "free_org_cap",
};

beforeEach(() => {
  vi.clearAllMocks();
  listUserOrgs.mockResolvedValue([ALPHA, BETA]);
});

// The gate, after the URL move. The org now comes from the URL, and the URL is CLIENT INPUT — exactly like a
// hidden form field. What makes that safe is not that it is validated, but WHERE:
//
// A *global* slug -> orgId lookup is structurally impossible for webhook_app (its only `orgs` policy is
// `id = current_org_id()`), and the "obvious" fix — a permissive policy — is the escalation ADR-0113 removed.
// So the slug is resolved INSIDE THE CALLER'S OWN DIRECTORY. Resolution and the membership check therefore
// become THE SAME OPERATION: they cannot drift apart, because there is only one of them.
describe("requireOrgAccess(slug)", () => {
  it("resolves the slug to its org and returns the caller's role there", async () => {
    const access = await requireOrgAccess("beta-corp");

    expect(access).toMatchObject({
      userId: "usr_1",
      orgId: "org_beta",
      slug: "beta-corp",
      role: "member",
    });
  });

  it("takes the org from the URL, NOT from the session cookie", async () => {
    // The cookie says `org_default`. The URL says Alpha. The URL wins — that is the whole point: with one
    // cookie per browser, a second tab that switched orgs would otherwise silently retarget this one's writes.
    const access = await requireOrgAccess("alpha");

    expect(access.orgId).toBe("org_alpha");
    expect(access.orgId).not.toBe("org_default");
  });

  it("404s — never redirects to sign-in — for a slug you are not a member of", async () => {
    // Two reasons, and both matter.
    //
    // 1. `redirect(LOGIN_URL)` would INFINITE-LOOP on a bookmarked foreign-org URL: auth signs you straight
    //    back in, you land on the same URL, and it bounces you out again.
    // 2. A 404 is also what denies the enumeration oracle. A 403 would confirm the org EXISTS — a free "does
    //    this company use webhook.co?" probe. Here there is nothing to confirm: a slug you don't belong to is
    //    indistinguishable from one nobody ever registered, because the resolver never sees either.
    await expect(requireOrgAccess("someone-elses-org")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("still redirects to sign-in when there is NO session at all", async () => {
    verifySession.mockRejectedValueOnce(new Error(`NEXT_REDIRECT:${LOGIN_URL}`));

    await expect(requireOrgAccess("alpha")).rejects.toThrow(`NEXT_REDIRECT:${LOGIN_URL}`);
    expect(listUserOrgs).not.toHaveBeenCalled(); // never reaches the directory
  });

  it("fails closed when the caller belongs to nothing", async () => {
    listUserOrgs.mockResolvedValue([]);
    await expect(requireOrgAccess("alpha")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  describe("former slugs — a rename must not break anyone's links", () => {
    it("308s a retired slug to the current one, PRESERVING the deep path", async () => {
      await expect(requireOrgAccess("beta-old", "/endpoints/ep_1/events")).rejects.toThrow(
        "NEXT_PERMANENT_REDIRECT:/org/beta-corp/endpoints/ep_1/events",
      );
    });

    it("PRESERVES the query string on the 308 — filters and cursor survive a rename", async () => {
      // The whole point of former-slug history is that old links keep working. A shared, FILTERED, paginated
      // events link that dropped its ?status=&cursor= on redirect would land the recipient on an unfiltered,
      // un-paginated list — the link would "work" while silently losing what made it worth sharing. The
      // caller carries its query in the subPath; the redirect must keep it.
      await expect(
        requireOrgAccess("beta-old", "/endpoints/ep_1/events?status=failed&cursor=abc"),
      ).rejects.toThrow(
        "NEXT_PERMANENT_REDIRECT:/org/beta-corp/endpoints/ep_1/events?status=failed&cursor=abc",
      );
    });

    it("resolves a retired slug straight through when there is no path to redirect to (an action)", async () => {
      // A server action does not render, so there is nothing to redirect. It must still ACT on the right org —
      // refusing here would break a form posted from a page the user loaded seconds before the rename.
      const access = await requireOrgAccess("beta-ancient");

      expect(access.orgId).toBe("org_beta");
      expect(access.slug).toBe("beta-corp"); // the CURRENT slug, for revalidatePath and links
    });
  });

  describe("canonical case", () => {
    // `orgs.slug` is citext, so the DB matches case-insensitively — but JS `===` does not. If the app compares
    // case-sensitively while the DB does not, a resolver and an authorization check can disagree about which
    // org a URL names. Compare case-insensitively, then 308 to the one true spelling.
    it("308s /org/ALPHA to /org/alpha", async () => {
      await expect(requireOrgAccess("ALPHA", "/endpoints")).rejects.toThrow(
        "NEXT_PERMANENT_REDIRECT:/org/alpha/endpoints",
      );
    });

    it("resolves a mis-cased slug without a redirect when there is no path (an action)", async () => {
      const access = await requireOrgAccess("Beta-Corp");
      expect(access.orgId).toBe("org_beta");
      expect(access.slug).toBe("beta-corp");
    });
  });

  it("threads the org's status and suspension reason onto the access", async () => {
    listUserOrgs.mockResolvedValue([SUSPENDED]);
    const access = await requireOrgAccess("paused-co");
    expect(access).toMatchObject({ status: "suspended", suspendedReason: "free_org_cap" });
  });
});

describe("requireActiveOrgAccess(slug) — the suspend-aware read gate", () => {
  it("returns access unchanged for an ACTIVE org (no divert)", async () => {
    const access = await requireActiveOrgAccess("alpha", "/dashboard");
    expect(access.orgId).toBe("org_alpha");
    expect(access.status).toBe("active");
  });

  it("DIVERTS a suspended org's read surface to its /suspended screen", async () => {
    listUserOrgs.mockResolvedValue([SUSPENDED]);
    await expect(requireActiveOrgAccess("paused-co", "/dashboard")).rejects.toThrow(
      "NEXT_REDIRECT:/org/paused-co/suspended",
    );
  });

  it("diverts even an action call (no subPath) for a suspended org", async () => {
    // A server action reaching a suspended org must also stop — a suspended org is read-only, so no write path
    // may proceed. With no subPath there's no canonicalization redirect, so the suspend redirect is the throw.
    listUserOrgs.mockResolvedValue([SUSPENDED]);
    await expect(requireActiveOrgAccess("paused-co")).rejects.toThrow(
      "NEXT_REDIRECT:/org/paused-co/suspended",
    );
  });

  it("canonicalizes BEFORE diverting — a mis-cased suspended slug 308s to the canonical URL first", async () => {
    // requireActiveOrgAccess delegates the 308 to requireOrgAccess, so a mis-cased/retired slug is corrected
    // first; the suspension divert then targets the canonical slug on the next request.
    listUserOrgs.mockResolvedValue([SUSPENDED]);
    await expect(requireActiveOrgAccess("Paused-CO", "/dashboard")).rejects.toThrow(
      "NEXT_PERMANENT_REDIRECT:/org/paused-co/dashboard",
    );
  });
});
