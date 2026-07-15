import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildEventDashboardUrl,
  DASHBOARD_SLUG_UNRESOLVED_HELP,
  makeOpenEventEffect,
} from "./dashboard-url.js";

describe("buildEventDashboardUrl", () => {
  it("builds the /org/<slug>/endpoints/<endpointId>/events/<eventId> dashboard path", () => {
    expect(
      buildEventDashboardUrl({
        base: "https://app.webhook.co",
        slug: "choraria",
        endpointId: "d7145af4-9084-4077-b50a-80f93a70f235",
        eventId: "019f6714-034b-7de4-8899-ae744af150b5",
      }),
    ).toBe(
      "https://app.webhook.co/org/choraria/endpoints/d7145af4-9084-4077-b50a-80f93a70f235/events/019f6714-034b-7de4-8899-ae744af150b5",
    );
  });

  it("url-encodes each dynamic segment (defense-in-depth against odd slugs/ids)", () => {
    expect(
      buildEventDashboardUrl({
        base: "https://app.webhook.co",
        slug: "a/b",
        endpointId: "e p",
        eventId: "x?y",
      }),
    ).toBe("https://app.webhook.co/org/a%2Fb/endpoints/e%20p/events/x%3Fy");
  });

  it("tolerates a base that carries a trailing slash", () => {
    expect(
      buildEventDashboardUrl({
        base: "https://app.webhook.co/",
        slug: "s",
        endpointId: "ep",
        eventId: "ev",
      }),
    ).toBe("https://app.webhook.co/org/s/endpoints/ep/events/ev");
  });
});

describe("makeOpenEventEffect", () => {
  it("opens the full /org/<slug>/endpoints/<endpointId>/events/<eventId> link when the slug resolves", async () => {
    const opened: string[] = [];
    const open = makeOpenEventEffect({
      base: "https://app.webhook.co",
      resolveSlug: async () => "choraria",
      openBrowser: async (u) => void opened.push(u),
    });
    const r = await open({ id: "ev1", endpointId: "ep1" });
    expect(r.ok).toBe(true);
    expect(opened).toEqual(["https://app.webhook.co/org/choraria/endpoints/ep1/events/ev1"]);
  });

  it("NEVER opens a broken link when the slug can't be resolved — returns the shared guidance instead", async () => {
    const opened: string[] = [];
    const open = makeOpenEventEffect({
      base: "https://app.webhook.co",
      resolveSlug: async () => undefined,
      openBrowser: async (u) => void opened.push(u),
    });
    const r = await open({ id: "ev1", endpointId: "ep1" });
    expect(r.ok).toBe(false);
    expect(opened).toEqual([]); // the whole point: no 404 dead-link
    expect(r.message).toBe(DASHBOARD_SLUG_UNRESOLVED_HELP); // same wording as `events open` (parity)
  });

  it("the SUCCESS status carries the url (io.openBrowser can't confirm a launch — headless-safe, no false claim)", async () => {
    // The real io.openBrowser resolves even when nothing opened (best-effort), so the message must not claim
    // success outright and must surface the url for the user to copy.
    const open = makeOpenEventEffect({
      base: "https://app.webhook.co",
      resolveSlug: async () => "choraria",
      openBrowser: async () => {}, // resolves like the real impl even on a headless box
    });
    const r = await open({ id: "ev1", endpointId: "ep1" });
    expect(r.ok).toBe(true);
    expect(r.message).toContain("https://app.webhook.co/org/choraria/endpoints/ep1/events/ev1");
  });

  it("on a browser-launch failure (headless/SSH) returns a CLEAN message carrying the url — no raw error", async () => {
    const open = makeOpenEventEffect({
      base: "https://app.webhook.co",
      resolveSlug: async () => "choraria",
      openBrowser: async () => {
        throw new Error("spawn xdg-open ENOENT"); // the kind of raw system error we must NOT leak
      },
    });
    const r = await open({ id: "ev1", endpointId: "ep1" });
    expect(r.ok).toBe(false);
    expect(r.message).not.toContain("ENOENT"); // no raw system error surfaced
    expect(r.message).toContain("https://app.webhook.co/org/choraria/endpoints/ep1/events/ev1"); // url to copy
  });
});

describe("dashboard route-shape drift guard", () => {
  // buildEventDashboardUrl hardcodes `/org/<slug>/endpoints/<endpointId>/events/<eventId>`, but apps/web
  // owns the real route. The org-URL lane restructured these routes once already; if web renames a static
  // segment (org/endpoints/events) or restructures the nesting, this guard fails so the CLI can't silently
  // keep emitting a 404 deep-link. It tolerates the dynamic param-folder NAMES ([slug]/[id]/[eventId]) since
  // those don't affect the URL — only the static segments and nesting do.
  /* eslint-disable security/detect-non-literal-fs-filename -- every fs path in this guard is derived from
     this test file's own location + static string segments, never from user input: no traversal surface. */
  it("the CLI's event deep-link shape still matches the apps/web route", () => {
    const here = dirname(fileURLToPath(import.meta.url)); // packages/cli/src
    const webAppRoot = join(here, "..", "..", "..", "apps", "web", "src", "app");
    if (!existsSync(webAppRoot)) return; // standalone published-CLI checkout — no sibling web app to drift against
    // apps/web IS present → SOME dynamic child at each of org → endpoints → events (whatever the param folder
    // is named) must continue the chain to a page.tsx. We tolerate additional dynamic siblings (an unrelated
    // new route mustn't break this guard) — we only assert the URL-relevant static chain still exists.
    const dynamicChildren = (dir: string): string[] =>
      existsSync(dir)
        ? readdirSync(dir, { withFileTypes: true })
            .filter((d) => d.isDirectory() && d.name.startsWith("[") && d.name.endsWith("]"))
            .map((d) => join(dir, d.name))
        : [];
    const chainReachesEventPage = dynamicChildren(join(webAppRoot, "(app)", "org")).some((orgDir) =>
      dynamicChildren(join(orgDir, "endpoints")).some((epDir) =>
        dynamicChildren(join(epDir, "events")).some((evDir) => existsSync(join(evDir, "page.tsx"))),
      ),
    );
    expect(
      chainReachesEventPage,
      "apps/web event-detail route drifted from the CLI's hardcoded /org/<slug>/endpoints/<endpointId>/events/<eventId> shape — update buildEventDashboardUrl",
    ).toBe(true);
  });
  /* eslint-enable security/detect-non-literal-fs-filename */
});
