"use client";

import { COMMAND_ITEMS } from "./app-nav";
import { CommandPalette } from "./command-palette";
import { useOrgSlug } from "@/lib/org-path";

/**
 * The ⌘K palette, bound to the org in the URL.
 *
 * This wrapper exists because of a real client/server boundary error, not for tidiness. `COMMAND_ITEMS` became
 * a function of the slug, and it lives in `app-nav.tsx` — a `"use client"` module. A SERVER component (the
 * layout) cannot CALL a function exported from a client module; it may only render it as a component or pass
 * it as a prop. Next throws at runtime:
 *
 *     Attempted to call COMMAND_ITEMS() from the server but COMMAND_ITEMS is on the client.
 *
 * tsc does not catch it, and no unit test did either — it took the browser. So the call moves to the client,
 * where it belongs, and reads the slug from the URL like every other client component in the shell.
 *
 * `CommandPalette` keeps taking `items` as a prop, so it stays directly testable with injected items.
 */
export function OrgCommandPalette() {
  const slug = useOrgSlug();
  return <CommandPalette items={COMMAND_ITEMS(slug)} />;
}
