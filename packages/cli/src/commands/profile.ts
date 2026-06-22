import { buildCommand, buildRouteMap } from "@stricli/core";

import type { AppContext } from "../context.js";
import { InvalidProfileNameError } from "../errors.js";
import {
  globalFlags,
  isReservedProfileName,
  resolveActiveProfile,
  resolveGlobals,
  type GlobalFlags,
} from "../global-flags.js";
import { EXIT } from "../output/exit-codes.js";
import { renderJson } from "../output/format.js";
import { sanitizeControl } from "../output/safe-text.js";

// `wbhk profile use|current|list|remove` — manage the named profiles the rest of the CLI selects via
// `--profile` / `WBHK_PROFILE` / the persisted active profile (ADR-0039). `use` persists the active
// profile; `current` shows the effective one + its source; `list` shows all, marking the active; `remove`
// deletes one (clearing the active pointer if it pointed there). Profiles are created implicitly by
// `login --profile <name>`, so there is no explicit `add` (an empty profile holds nothing) — deferred.

type ProfileFlags = GlobalFlags;

const nameParam = {
  kind: "tuple",
  parameters: [{ parse: (v: string): string => v, brief: "the profile name", placeholder: "name" }],
} as const;

export const profileUseCommand = buildCommand<ProfileFlags, [string], AppContext>({
  async func(this: AppContext, flags, name) {
    if (isReservedProfileName(name)) return new InvalidProfileNameError(name);
    await this.store.setActiveProfile?.(name);
    // A heads-up (stderr) when the profile holds no credential yet — the switch is still valid.
    if ((await this.store.get(name)) === null) {
      const safe = sanitizeControl(name);
      this.process.stderr.write(
        `no credential stored for \`${safe}\` yet — run \`wbhk --profile ${safe} login\`.\n`,
      );
    }
    const { format } = resolveGlobals(this, flags);
    this.process.stdout.write(
      format === "json"
        ? `${renderJson({ active: name })}\n`
        : `switched to profile \`${sanitizeControl(name)}\`\n`,
    );
  },
  parameters: { positional: nameParam, flags: { ...globalFlags } },
  docs: { brief: "switch the active profile" },
});

export const profileCurrentCommand = buildCommand<ProfileFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    // `current` is read-only, so a reserved name is shown (not rejected) — resolveActiveProfile is the
    // display-safe (non-throwing) resolver, shared with `resolveProfile` + `list` so they never disagree.
    const { name: active, source } = await resolveActiveProfile(this, flags);
    const { format } = resolveGlobals(this, flags);
    this.process.stdout.write(
      format === "json"
        ? `${renderJson({ active, source })}\n`
        : `${sanitizeControl(active)} (${source})\n`,
    );
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "show the active profile and where it's set" },
});

export const profileListCommand = buildCommand<ProfileFlags, [], AppContext>({
  async func(this: AppContext, flags) {
    const profiles = (await this.store.list()).sort();
    // The EFFECTIVE active (flag/env/persisted/default) — same resolver `current` uses, so the `*` marker
    // and `profile current` always agree (e.g. WBHK_PROFILE is reflected here too).
    const { name: active } = await resolveActiveProfile(this, flags);
    const { format } = resolveGlobals(this, flags);
    if (format === "json") {
      this.process.stdout.write(`${renderJson({ profiles, active })}\n`);
      return;
    }
    if (profiles.length === 0) {
      this.process.stdout.write("no profiles yet — run `wbhk login` to create one.\n");
      return;
    }
    // `* name` for the active profile, `  name` otherwise (a left margin keeps the names aligned).
    const lines = profiles.map((p) => `${p === active ? "*" : " "} ${sanitizeControl(p)}`);
    this.process.stdout.write(`${lines.join("\n")}\n`);
  },
  parameters: { flags: { ...globalFlags } },
  docs: { brief: "list configured profiles" },
});

export const profileRemoveCommand = buildCommand<ProfileFlags, [string], AppContext>({
  async func(this: AppContext, flags, name) {
    if (isReservedProfileName(name)) return new InvalidProfileNameError(name);
    if (!(await this.store.list()).includes(name)) {
      this.process.stderr.write(`no profile named \`${sanitizeControl(name)}\`.\n`);
      this.process.exitCode = EXIT.USAGE;
      return;
    }
    await this.store.erase(name);
    // If it was the persisted active profile, clear the pointer so resolution falls back to default.
    if ((await this.store.getActiveProfile?.()) === name) {
      await this.store.setActiveProfile?.(undefined);
    }
    const { format } = resolveGlobals(this, flags);
    this.process.stdout.write(
      format === "json"
        ? `${renderJson({ removed: name })}\n`
        : `removed profile \`${sanitizeControl(name)}\`\n`,
    );
  },
  parameters: { positional: nameParam, flags: { ...globalFlags } },
  docs: { brief: "delete a profile and its stored credential" },
});

export const profileRoute = buildRouteMap({
  routes: {
    use: profileUseCommand,
    current: profileCurrentCommand,
    list: profileListCommand,
    remove: profileRemoveCommand,
  },
  docs: { brief: "manage CLI profiles (named credentials + base URLs)" },
});
