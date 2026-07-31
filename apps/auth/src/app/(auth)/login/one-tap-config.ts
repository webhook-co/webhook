import "server-only";

import { getCloudflareContext } from "@opennextjs/cloudflare";
import { readSecretBinding } from "@webhook-co/shared";

import { configuredSocialProviders } from "@/runtime/env";

/**
 * The Google OAuth client id the login page hands to Google Identity Services, resolved on the SERVER
 * from the same Secrets Store binding that keys the "Continue with Google" button — or `null` for
 * "do not offer One Tap".
 *
 * WHY THE SECRET AND NOT A COMMITTED CONSTANT. A client id is public by construction: whichever route
 * it takes it ends up in the login page's HTML. The question is only whether it lives in git, and three
 * things settle that against committing it:
 *
 *   1. This repo is PUBLIC and open-core. A hardcoded id is webhook.co's id baked into everyone's build
 *      — a self-hoster with their own Google OAuth app would get a prompt bound to OUR audience, which
 *      fails as `unregistered_origin`: console-only, no user-visible signal. Reading the binding means
 *      their own app just works, which is what the open-core boundary is supposed to buy them.
 *   2. `.cursor/rules/no-secrets.mdc` (alwaysApply) forbids committing cloud ACCOUNT IDENTIFIERS. The
 *      numeric prefix of a Google client id is the GCP project number. Not a credential, but squarely
 *      the class of thing that rule exists to keep out of a public repo.
 *   3. Committing it would create a second source of truth for the audience, and then require a
 *      drift-detector to police the two against each other. Reading the one binding that already keys
 *      verification makes the drift UNREPRESENTABLE instead of merely detectable. The browser's account
 *      chooser and the server's audience check cannot disagree, because they are the same value.
 *
 * FAILS OFF, DELIBERATELY THE OPPOSITE OF `socialProvidersForLogin`. That function fails safe by showing
 * BOTH buttons, because a login page with no visible way in reads as an outage. This one fails to `null`,
 * because One Tap is an enhancement layered on a page that already works without it: a prompt bound to
 * an audience we could not confirm is strictly worse than no prompt. Every fault — no context, no env,
 * a rejecting `.get()`, an empty or malformed value — lands on `null`, and nothing here can throw into
 * the render of a page that must load for every visitor.
 *
 * COST. One Secrets Store read on the signed-out login render, and only when Google is configured at
 * all. `configuredSocialProviders` gates first on PRESENCE, so the `OAUTH_MODE=optional` contributor
 * pays nothing. It also earns something back: `env.ts` documents a reachable mis-provisioning — a
 * binding that resolves to an empty string — that it explicitly declines to detect on the button path
 * because doing so would mean resolving all four OAuth secrets. Resolving this one catches that case
 * for One Tap rather than rendering a prompt that cannot complete.
 */
export async function googleOneTapClientId(): Promise<string | null> {
  try {
    const { env } = await getCloudflareContext({ async: true });
    const record = env as unknown as Record<string, unknown>;

    // Gate on the SAME id+secret pair the button gates on, via the same function, so the two surfaces
    // cannot drift into a state where One Tap is offered but the callback has no secret to complete with.
    if (!configuredSocialProviders(record).google) return null;

    const resolved = (await readSecretBinding(record.GOOGLE_CLIENT_ID as never)).trim();
    if (!isGoogleClientId(resolved)) {
      if (resolved.length > 0) {
        // Present but not shaped like a client id. Name the event, NEVER the value — the whole reason
        // this branch exists is that the value might be the client SECRET.
        console.warn("one_tap.client_id_malformed: GOOGLE_CLIENT_ID is not a Google client id");
      }
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Whether a resolved value is shaped like a Google OAuth client id.
 *
 * This is a mis-provisioning guard, not a security boundary — Google rejects a wrong audience on its
 * own. It exists for one specific, plausible deploy fault: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
 * are adjacent keys in every config file this repo has, and swapping them would otherwise render the
 * CLIENT SECRET into an HTML attribute on a public, signed-out page for every visitor. Google secrets
 * carry a `GOCSPX-` prefix and can never match this, so one regex converts a credential disclosure into
 * "One Tap quietly does not appear".
 *
 * Both live formats are accepted: the current `<project-number>-<random>.apps.googleusercontent.com`
 * and the legacy suffix-less `<project-number>.apps.googleusercontent.com`. Over-strictness has a real
 * cost — a valid id that fails here means One Tap silently never renders — which is why the caller logs
 * the rejection rather than swallowing it.
 */
function isGoogleClientId(value: string): boolean {
  return /^\d+(-[a-z0-9]+)?\.apps\.googleusercontent\.com$/.test(value);
}
