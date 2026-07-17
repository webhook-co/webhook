import { expect, test } from "@playwright/test";
import { createClient, withTenant } from "@webhook-co/db/client";
import { createEndpoint } from "@webhook-co/db/endpoints";
import { createCredentialHasher, CREDENTIAL_PEPPER_MIN_BYTES } from "@webhook-co/db/credential";
import { newId } from "@webhook-co/shared";

import { signIn, world } from "./support";

// The consolidated org-wide events browse, in a real browser against a real Postgres.
//
// This suite exists because the unit tests CANNOT see what it checks. They render EventsTable with props and
// mock next/navigation — so they prove the component maps data to markup, and nothing about whether the page
// composes: whether the RSC gate lets you in, whether the DB read is wired to the right reader, whether RLS
// actually scopes it, whether the sidebar link goes anywhere, or whether a row's href resolves to a page that
// EXISTS. Every one of those is a way this feature ships broken with a green unit suite.
//
// Serial: the specs share one seeded set of events, and the isolation spec asserts an ABSENCE.
test.describe.configure({ mode: "serial" });

const hasher = createCredentialHasher({
  current: Buffer.alloc(CREDENTIAL_PEPPER_MIN_BYTES, 0xe5),
});

interface Seeded {
  readonly alphaOne: string;
  readonly alphaTwo: string;
  readonly betaEndpointId: string;
  readonly betaEventId: string;
  readonly alphaEventOnTwo: string;
}

/**
 * Seed events straight into the DB: there is no UI that creates one (they arrive by ingest), and driving the
 * engine from here would be testing the engine. Everything the BROWSER then does is real.
 */
async function seed(): Promise<Seeded> {
  const { orgs, appConnectionString } = world();
  const db = createClient(appConnectionString, { max: 1 });
  try {
    const mk = async (orgId: string, name: string) =>
      (await createEndpoint(db, { orgId, name }, hasher)).id;

    const alphaOne = await mk(orgs.alpha.id, "alpha-one");
    const alphaTwo = await mk(orgs.alpha.id, "alpha-two");
    const betaEndpointId = await mk(orgs.beta.id, "beta-only");

    const event = async (orgId: string, endpointId: string, provider: string) => {
      const id = newId();
      await withTenant(
        db,
        orgId,
        (tx) => tx`
          insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, headers,
                              dedup_key, dedup_strategy, provider, verified)
          values (${id}, ${orgId}, ${endpointId}, ${`k/${id}`}, 10, '[]'::jsonb,
                  ${`unique:${id}`}, 'unique', ${provider}, true)`,
      );
      return id;
    };

    // Alpha's events span TWO endpoints — the whole point of the page. Beta gets one, to prove isolation.
    const alphaEventOnOne = await event(orgs.alpha.id, alphaOne, "stripe");
    const alphaEventOnTwo = await event(orgs.alpha.id, alphaTwo, "github");
    const betaEventId = await event(orgs.beta.id, betaEndpointId, "stripe");

    return { alphaOne: alphaEventOnOne, alphaTwo, betaEndpointId, betaEventId, alphaEventOnTwo };
  } finally {
    await db.end();
  }
}

let seeded: Seeded;

test.beforeAll(async () => {
  seeded = await seed();
});

test("lists events from EVERY endpoint in the org, and links each row to ITS OWN endpoint", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events`);

  await expect(page.getByRole("heading", { name: "Events", level: 1 })).toBeVisible();

  // Both endpoints' events on one page — an endpoint-scoped list can only ever show one of these.
  await expect(page.getByRole("cell", { name: "alpha-one" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "alpha-two" })).toBeVisible();

  // THE BUG SLICE 0 FIXED, end to end. The href must carry the ROW's endpoint, not the list's. Built from the
  // wrong one, every row 404s (loadEvent asserts event.endpointId !== endpointId -> not_found) — and no unit
  // test could tell, because on the per-endpoint page the two values are always equal.
  const row = page.getByRole("row").filter({ hasText: seeded.alphaEventOnTwo });
  await expect(row.getByRole("link")).toHaveAttribute(
    "href",
    `/org/${orgs.alpha.slug}/endpoints/${seeded.alphaTwo}/events/${seeded.alphaEventOnTwo}`,
  );

  // The org-wide live-tail toggle must actually render — a unit test can't see whether the RSC page WIRED the
  // live props (liveWsUrl + the org mint action) into OrgEventsList; if it forgot, `liveAvailable` is false
  // and the button never appears. We only assert it's present + toggles (no live socket in the e2e env).
  await expect(page.getByRole("button", { name: /go live/i })).toBeVisible();
});

test("a row's link actually resolves to the event detail page (it is not a 404)", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events`);

  // FOLLOW the link rather than assert its shape. A well-formed href to a page that 404s is exactly what a
  // wrong endpointId produces, and only navigating can tell the difference.
  await page.getByRole("row").filter({ hasText: seeded.alphaEventOnTwo }).getByRole("link").click();

  await expect(page).toHaveURL(new RegExp(`/events/${seeded.alphaEventOnTwo}$`));
  await expect(page.getByText(seeded.alphaEventOnTwo).first()).toBeVisible();
});

test("is RLS-scoped: another org's events never appear", async ({ page }) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events`);

  // A concrete absence, not a bare "the page loaded": Beta's event id and its endpoint's name must BOTH be
  // missing. RLS is the only thing scoping this read — the query carries no org_id predicate.
  await expect(page.getByText(seeded.betaEventId)).toHaveCount(0);
  await expect(page.getByRole("cell", { name: "beta-only" })).toHaveCount(0);
});

test("the sidebar reaches it, and highlights Events — not Endpoints — on both events routes", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/dashboard`);

  // The nav link exists, is nested under Endpoints, and goes somewhere.
  await page.getByRole("link", { name: "Events", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/org/${orgs.alpha.slug}/events$`));
  await expect(page.getByRole("link", { name: "Events", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );

  // THE ACTIVE-STATE TRAP. /endpoints/<id>/events starts with /endpoints, so the old prefix rule lit up
  // ENDPOINTS while the reader was looking at events. Exactly one item may be current, and it must be Events.
  await page.goto(`/org/${orgs.alpha.slug}/endpoints/${seeded.alphaTwo}/events`);
  await expect(page.getByRole("link", { name: "Events", exact: true })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.getByRole("link", { name: "Endpoints", exact: true })).not.toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(page.locator("nav a[aria-current='page']")).toHaveCount(1);
});

test("the endpoint drill-down filters to one endpoint and back", async ({ page }) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events`);

  await page.getByRole("button", { name: /Filter by endpoint/ }).click();
  await page.getByRole("option", { name: "alpha-two" }).click();

  // The drill-down is URL-driven, so the filtered view is shareable and refresh-safe.
  await expect(page).toHaveURL(new RegExp(`endpointId=${seeded.alphaTwo}`));
  await expect(page.getByRole("cell", { name: "alpha-two" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "alpha-one" })).toHaveCount(0);

  // "All endpoints" must actually CLEAR it — a filter you cannot undo is a trap.
  await page.getByRole("button", { name: /Filter by endpoint/ }).click();
  await page.getByRole("option", { name: "All endpoints" }).click();
  await expect(page.getByRole("cell", { name: "alpha-one" })).toBeVisible();
});

// THE DEFAULT MUST BE ESCAPABLE — in a real browser, through a real URL round trip.
//
// The org page defaults to 7d (an unbounded org-wide browse degrades to a blocking Sort: ~32s at 100M rows).
// A default is only honest if the reader can leave it. It shipped unleavable, and the code CLAIMED the
// opposite: "Any time is one click away" — while no control cleared the range.
//
// A unit test cannot cover this. The failure lives in the round trip: the bar deletes empty params, the page
// defaults on absent ones, so a naive "clear" button returns to 7d and the chip reads "Any time" over 7-day
// data. That is a page+URL+RSC behaviour — exactly what mocked next/navigation cannot see, and exactly the
// shape that already shipped once with a green suite.
test("the 7d default is escapable: 'Any time' survives the URL round trip", async ({ page }) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events`);

  // The TRIGGER, by its aria-label — not a bare /Any time/, which also matches the menu item inside the open
  // popover. The default is DISCLOSED, not silent: the chip names the window it applied even though the URL
  // carries no ?range=.
  const trigger = page.getByRole("button", { name: /^Filter by received date:/ });
  await expect(trigger).toHaveAccessibleName(/Last 7 days/);

  await trigger.click();
  await page.getByRole("button", { name: "Any time", exact: true }).click();

  // An explicit token, NOT an absent param. If this ever regresses to clearing the params, the URL loses
  // `range` and the page silently re-applies 7d — with the chip still claiming "Any time".
  await expect(page).toHaveURL(/[?&]range=all\b/);
  await expect(trigger).toHaveAccessibleName(/Any time/);

  // The round trip is the assertion: reload, and the choice must SURVIVE rather than default back.
  await page.reload();
  await expect(trigger).toHaveAccessibleName(/Any time/);
  await expect(trigger).not.toHaveAccessibleName(/Last 7 days/);
});

// A typo must not become an unbounded scan. `?range=bogus` used to count as "date intent" purely by being
// PRESENT, so it resolved to no bound at all — the exact ~32s query the default exists to prevent, reachable
// by fat-fingering a URL. Only a KNOWN token is intent now; junk falls back to the default.
test("a junk ?range= falls back to the default rather than widening to all-time", async ({
  page,
}) => {
  const { users, orgs } = world();
  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events?range=bogus`);

  await expect(
    page.getByRole("button", { name: /^Filter by received date:/ }),
  ).toHaveAccessibleName(/Last 7 days/);
});

// THE NEW FACETS, end to end — method + event type filter the real list through the URL. Unit tests can't
// prove this: the facet control is a Client Component, the filter is applied in the RSC read, and only a real
// navigation exercises the round trip. Seeds its own endpoint + events (with method/event_type the shared
// seed omits) so the assertions are about rows this test controls.
test("the method + event-type facets filter the org list (and NULL-method rows drop out)", async ({
  page,
}) => {
  const { orgs, users, appConnectionString } = world();
  const db = createClient(appConnectionString, { max: 1 });
  let getId: string;
  let postId: string;
  try {
    const ep = (await createEndpoint(db, { orgId: orgs.alpha.id, name: "facet-ep" }, hasher)).id;
    const mk = async (method: string, eventType: string) => {
      const id = newId();
      await withTenant(
        db,
        orgs.alpha.id,
        (tx) => tx`
          insert into events (id, org_id, endpoint_id, payload_r2_key, payload_bytes, headers,
                              dedup_key, dedup_strategy, method, event_type, provider, verified)
          values (${id}, ${orgs.alpha.id}, ${ep}, ${`k/${id}`}, 10, '[]'::jsonb,
                  ${`unique:${id}`}, 'unique', ${method}, ${eventType}, 'stripe', true)`,
      );
      return id;
    };
    getId = await mk("GET", "charge.succeeded");
    postId = await mk("POST", "invoice.paid");
  } finally {
    await db.end();
  }

  await signIn(page, users.dana.id, orgs.alpha.id);
  await page.goto(`/org/${orgs.alpha.slug}/events`);

  // Pick method = GET. The URL carries it, the GET row stays, the POST row and every NULL-method shared
  // event drop (a `method in (...)` filter never matches NULL).
  await page.getByRole("button", { name: /Filter by HTTP method/ }).click();
  await page.getByRole("option", { name: "GET", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(/[?&]method=GET\b/);
  await expect(page.getByRole("cell", { name: getId })).toBeVisible();
  await expect(page.getByRole("cell", { name: postId })).toHaveCount(0);

  // Event type is an exact free match, committed on Enter. Narrow to invoice.paid: neither the GET row
  // (charge.succeeded) nor the method filter's survivors match, and the POST row returns.
  await page.getByRole("button", { name: /Filter by HTTP method/ }).click();
  await page.getByRole("option", { name: "GET", exact: true }).click(); // clear method
  await page.keyboard.press("Escape");
  // WAIT for the method-clear navigation to fully settle before committing the next filter — otherwise the
  // two navigations race and the eventType filter can land on top of a not-yet-cleared method=GET, filtering
  // the POST row back out. The POST row returning is the signal the unfiltered list has re-seeded. (The
  // earlier method step waits the same way; this step must too.)
  await expect(page).not.toHaveURL(/[?&]method=GET\b/);
  await expect(page.getByRole("cell", { name: postId })).toBeVisible();
  const eventTypeInput = page.getByLabel("Filter by event type");
  await eventTypeInput.fill("invoice.paid");
  await eventTypeInput.press("Enter");
  await expect(page).toHaveURL(/[?&]eventType=invoice\.paid\b/);
  await expect(page.getByRole("cell", { name: postId })).toBeVisible();
  await expect(page.getByRole("cell", { name: getId })).toHaveCount(0);
});
