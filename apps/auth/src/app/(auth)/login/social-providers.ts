import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";

import { configuredSocialProviders } from "@/runtime/env";

import type { ConfiguredProviders } from "./login-form";

/**
 * Which social buttons the login page should offer, decided on the SERVER from what is actually configured.
 *
 * In production both OAuth apps are always provisioned, so this returns both and the page renders exactly as
 * before. It exists for OAUTH_MODE=optional: a contributor with no Google or GitHub OAuth app must not be
 * shown a button that posts to a provider Better Auth was never given.
 *
 * Fails SAFE by showing both. This runs on a page that must render for a signed-out visitor, so an
 * unexpected fault here has to degrade to the production shape rather than take the login page down or
 * silently strip every way in. A wrongly-shown button is a bad error message; a login page that will not
 * render is an outage.
 */
export async function socialProvidersForLogin(): Promise<ConfiguredProviders> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    return configuredSocialProviders(env as unknown as Record<string, unknown>);
  } catch {
    return { google: true, github: true };
  }
}
