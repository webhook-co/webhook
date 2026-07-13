import type { Page } from "@playwright/test";

import { readFixture, type Fixture } from "./fixture";

let cached: Fixture | null = null;

/**
 * The seeded world. Read lazily, not at module load: Playwright imports the spec files to collect tests, and
 * that can happen before globalSetup has written the fixture.
 */
export function world(): Fixture {
  cached ??= readFixture();
  return cached;
}

/**
 * Put a session cookie in the browser by driving the real `/dev-session` route, so the token is minted by the
 * production signer rather than by a re-implementation of the token format living in test code.
 *
 * Note this lands on `/`, which is gated — so only use it for a principal that is actually a member of `org`.
 * For a principal that is NOT (the isolation specs), use the request context instead and assert on the
 * redirect, because following it would hit the deliberately-dead auth origin.
 */
export async function signIn(page: Page, userId: string, orgId: string): Promise<void> {
  await page.goto(
    `/dev-session?user=${encodeURIComponent(userId)}&org=${encodeURIComponent(orgId)}`,
  );
}
