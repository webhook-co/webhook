import { permanentRedirect } from "next/navigation";

/**
 * Connected apps moved to `/account/connected-apps` — they are user-scoped, and never depended on the org
 * this URL names (`loadConnectedApps()` takes no `orgId`).
 *
 * A 308, not a deletion: this path has been live and is exactly the sort of thing a person bookmarks after
 * revoking an app once. It is the same courtesy the org-slug history extends to a renamed org.
 *
 * dal-gate-allow: a pure redirect stub — it renders nothing and reads nothing.
 */
export default function MovedToAccount(): never {
  permanentRedirect("/account/connected-apps");
}
