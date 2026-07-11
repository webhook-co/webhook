import "server-only";

import type { ConnectedApp } from "@webhook-co/contract";

import { getConnectedAppsBinding } from "./env";
import { verifySession } from "./session";

export type { ConnectedApp };

/**
 * The result of loading a user's connected apps. `unavailable` when the auth. binding isn't wired (dev /
 * pre-provision) — the page renders a graceful notice rather than an error, mirroring the credentials page.
 */
export type ConnectedAppsResult =
  { status: "ok"; apps: readonly ConnectedApp[] } | { status: "unavailable" };

/**
 * Load the signed-in user's active connected apps (their authorized OAuth clients) from auth. over the
 * ConnectedApps binding. Always scoped to the SERVER-verified session userId — never a client-supplied one.
 */
export async function loadConnectedApps(): Promise<ConnectedAppsResult> {
  const session = await verifySession();
  const binding = getConnectedAppsBinding();
  if (!binding) return { status: "unavailable" };
  const apps = await binding.list(session.userId);
  return { status: "ok", apps };
}
