// Build the canonical web-dashboard deep-link for a single captured event. The dashboard routes events
// under `/org/<slug>/endpoints/<endpointId>/events/<eventId>` (see apps/web app-router); the short
// `/events/<id>` form 404s. Each dynamic segment is URL-encoded as defence-in-depth so a non-uuid id or
// an unusual slug can never break out of the intended path.
export function buildEventDashboardUrl(args: {
  base: string;
  slug: string;
  endpointId: string;
  eventId: string;
}): string {
  const base = args.base.replace(/\/+$/, "");
  const seg = (s: string) => encodeURIComponent(s);
  return `${base}/org/${seg(args.slug)}/endpoints/${seg(args.endpointId)}/events/${seg(args.eventId)}`;
}

// One shared, on-voice message for "we couldn't resolve your org slug, so we won't open a broken link" —
// used identically by the `events open` command and the in-tail TUI `o` key so the two surfaces stay in
// parity (a wording edit lands in both at once). The org slug comes from a fast LOCAL source (the `--org`
// selection or the profile's persisted metadata); when neither exists (an older login), running `wbhk
// whoami` re-persists it — deliberately keeping any network lookup OFF the interactive open path.
export const DASHBOARD_SLUG_UNRESOLVED_HELP =
  "couldn't resolve your organization — run `wbhk whoami` to refresh it, then try again.";

// Build the "open this event in the dashboard" side effect for the in-tail TUI `o` key. Resolves the org
// slug (a fast local read supplied by the caller), then EITHER opens the correct deep-link OR — when the
// slug can't be resolved — returns actionable guidance WITHOUT opening anything (it must never open the
// bare `/events/<id>` form, the 404 this change eliminates). The status line ALWAYS carries the URL:
// io.openBrowser is best-effort and can't report whether a launcher exists (on a headless/SSH box the
// launch silently no-ops), so the message never claims success — it shows the link so the user can copy it
// if nothing opened. A launch that does reject degrades to the same clean, URL-carrying line (no raw error).
export function makeOpenEventEffect(deps: {
  base: string;
  resolveSlug: () => Promise<string | undefined>;
  openBrowser: (url: string) => Promise<void>;
}): (e: { id: string; endpointId: string }) => Promise<{ ok: boolean; message: string }> {
  return async (e) => {
    const slug = await deps.resolveSlug();
    if (!slug) {
      return { ok: false, message: DASHBOARD_SLUG_UNRESOLVED_HELP };
    }
    const url = buildEventDashboardUrl({
      base: deps.base,
      slug,
      endpointId: e.endpointId,
      eventId: e.id,
    });
    try {
      await deps.openBrowser(url);
    } catch {
      // io.openBrowser doesn't reject today, but stay clean if a future/injected impl does.
      return { ok: false, message: `couldn't open a browser — copy this link: ${url}` };
    }
    return { ok: true, message: `opening ${url} — copy the link if your browser didn't open` };
  };
}
