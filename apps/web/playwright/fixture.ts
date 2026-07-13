import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The seeded two-org world, handed from `global-setup.ts` to the specs.
 *
 * It travels as a file rather than in-process state because Playwright runs globalSetup and the specs in
 * separate worker processes — a module-level export set during setup is simply not there when a spec reads
 * it. `.tmp/` is gitignored and rewritten on every run.
 */
const FIXTURE_FILE = fileURLToPath(new URL("./.tmp/fixture.json", import.meta.url));

/** Where the suite drives the dashboard. Not 3000 — that is where a developer's own `next dev` lives. */
export const PORT = 3100;
export const BASE_URL = `http://127.0.0.1:${PORT}`;

export interface FixtureUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
}

export interface FixtureOrg {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
}

export interface Fixture {
  /**
   * The `webhook_app` connection string — the RLS-policed role the app itself connects as, never the
   * superuser. Specs use it to change the world behind the browser's back (removing a membership without
   * touching the session cookie, which is the only way to test what a stale cookie can still do).
   */
  readonly appConnectionString: string;
  readonly users: {
    readonly dana: FixtureUser;
    readonly robin: FixtureUser;
    /** A Beta member who exists to be removed. Dana's membership must survive for the other specs. */
    readonly sam: FixtureUser;
  };
  readonly orgs: { readonly alpha: FixtureOrg; readonly beta: FixtureOrg };
}

export function writeFixture(fixture: Fixture): void {
  mkdirSync(dirname(FIXTURE_FILE), { recursive: true });
  writeFileSync(FIXTURE_FILE, JSON.stringify(fixture, null, 2));
}

/** The fixture written by globalSetup. Throws if read before it ran. */
export function readFixture(): Fixture {
  return JSON.parse(readFileSync(FIXTURE_FILE, "utf8")) as Fixture;
}
