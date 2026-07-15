import { buildCommand, buildRouteMap } from "@stricli/core";

import type { AppContext } from "../context.js";
import { InvalidOrgSlugError } from "../errors.js";
import {
  displayFlags,
  resolveActiveProfile,
  resolveGlobals,
  resolveOrgSlugToProfile,
  type DisplayFlags,
} from "../global-flags.js";
import { renderJson } from "../output/format.js";
import { sanitizeControl } from "../output/safe-text.js";

// `wbhk org list|current|use` — a LOCAL view of which org each stored credential is bound to (token = org,
// fixed at consent and captured at login/whoami), plus a switcher. NEVER a server call: the org metadata is
// read from the profile config, so `list`/`current` work fully offline and `use` just re-points the active
// profile. This is a CLIENT-SIDE selector, NOT a contract capability — deliberately absent from
// app.ts's CAPABILITY_COMMANDS (adding an `orgs.*` entry there would trip the capability-parity ratchet).

type OrgFlags = DisplayFlags;

const slugParam = {
  kind: "tuple",
  parameters: [{ parse: (v: string): string => v, brief: "the org slug", placeholder: "slug" }],
} as const;

/** A trimmed, non-empty positional slug, or undefined (a blank arg is a usage error, not a fallthrough). */
function nonEmptySlug(slug: string): string | undefined {
  const trimmed = slug.trim();
  return trimmed === "" ? undefined : trimmed;
}

export const orgListCommand = buildCommand<OrgFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const profiles = (await this.store.list()).sort();
    // The EFFECTIVE active profile (flag/env/persisted/default) — the same resolver `profile`/`whoami` use,
    // so the `*` marker agrees with `wbhk org current`.
    const { name: activeProfile } = await resolveActiveProfile(this, flags);
    const rows = [] as { slug: string; name: string; profile: string; active: boolean }[];
    for (const profile of profiles) {
      const org = await this.store.getOrg(profile);
      if (org === undefined) continue; // only profiles whose credential carries a bound org
      rows.push({ slug: org.slug, name: org.name, profile, active: profile === activeProfile });
    }
    const { format } = resolveGlobals(this, flags);
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ orgs: rows })}\n`);
      return;
    }
    if (rows.length === 0) {
      this.process.stdout.write("no orgs yet — run `wbhk login` to add one.\n");
      return;
    }
    // `* slug — name (profile)` for the active profile, `  slug — …` otherwise (the left margin keeps the
    // slugs aligned). slug/name/profile are config-controlled → sanitized before the text view.
    const lines = rows.map(
      (r) =>
        `${r.active ? "*" : " "} ${sanitizeControl(r.slug)} — ${sanitizeControl(r.name)} ` +
        `(${sanitizeControl(r.profile)})`,
    );
    this.process.stdout.write(`${lines.join("\n")}\n`);
  },
  parameters: { flags: { ...displayFlags } },
  docs: { brief: "list the orgs your local credentials are bound to" },
});

export const orgCurrentCommand = buildCommand<OrgFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    // Display/discovery: the effective profile (profile-only, never the org selector) + its stored org.
    const { name: profile, source } = await resolveActiveProfile(this, flags);
    const org = await this.store.getOrg(profile);
    const { format } = resolveGlobals(this, flags);
    if (format === "json") {
      this.process.stdout.write(
        `${renderJson(org !== undefined ? { org, profile, source } : { org: null, profile, source })}\n`,
      );
      return;
    }
    if (org === undefined) {
      this.process.stdout.write(
        `no org bound to the active profile \`${sanitizeControl(profile)}\` (${source}) — ` +
          "run `wbhk login` to bind one.\n",
      );
      return;
    }
    this.process.stdout.write(
      `${sanitizeControl(org.slug)} (${sanitizeControl(org.name)}) — ` +
        `profile \`${sanitizeControl(profile)}\` (${source})\n`,
    );
  },
  parameters: { flags: { ...displayFlags } },
  docs: { brief: "show the org the active profile targets and where it's set" },
});

export const orgUseCommand = buildCommand<OrgFlags, [string], AppContext>({
  async func(this: AppContext, flags, slug) {
    // Resolve from the EXPLICIT positional slug — NEVER the ambient `WBHK_ORG` env selector. Trim ONCE and
    // use the trimmed value for BOTH the empty-guard and the resolver, so a whitespace/newline-padded `$SLUG`
    // (e.g. `org use " acme"`) still matches. An empty/blank positional is a usage error, not a fallthrough.
    const trimmed = nonEmptySlug(slug);
    if (trimmed === undefined) {
      return new InvalidOrgSlugError(slug, "provide an org slug, e.g. `wbhk org use acme`.");
    }
    const resolved = await resolveOrgSlugToProfile(this, trimmed); // throws OrgNotFound/Ambiguous
    await this.store.setActiveProfile?.(resolved.profile);
    const { format } = resolveGlobals(this, flags);
    this.process.stdout.write(
      format === "json"
        ? `${renderJson({ active: resolved.profile, org: resolved.org })}\n`
        : `switched to org ${sanitizeControl(resolved.org.slug)} ` +
            `(${sanitizeControl(resolved.org.name)}) — profile \`${sanitizeControl(resolved.profile)}\`\n`,
    );
  },
  parameters: { positional: slugParam, flags: { ...displayFlags } },
  docs: { brief: "switch the active profile to the credential bound to an org slug" },
});

export const orgRoute = buildRouteMap({
  routes: {
    list: orgListCommand,
    current: orgCurrentCommand,
    use: orgUseCommand,
  },
  docs: { brief: "inspect and switch the org your local credentials target (local; token = org)" },
});
