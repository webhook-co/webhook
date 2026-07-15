"use client";

import * as React from "react";

import { orgLogoVersion } from "@/lib/org-logo-version";

/**
 * An organization's avatar: its UPLOADED logo if it has one, else a deterministic generated tile (its initial
 * on a name-derived tint).
 *
 * The logo is served from OUR origin (`/api/org-logo/{slug}` — member-gated, private), layered over the
 * generated tile which shows underneath from the first paint (no empty frame) and remains the fallback: an org
 * with no logo answers 404, the `<img>` fires `error`, and the tile is all that's left. Same shape as
 * `UserAvatar`.
 *
 * The generated tile's hue is DERIVED from the name — stable across sessions/machines/renders without storing
 * anything, so "which org am I in?" is answered pre-attentively by colour before you read the word. Nothing
 * here is identity; a cheap hash is right.
 */
function hueFrom(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    // djb2-ish. `| 0` keeps it in int32 so a long name cannot drift into float territory.
    hash = (hash * 31 + name.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 360;
}

export interface OrgAvatarProps {
  readonly name: string;
  /** Pixels. The picker's trigger and its list rows want slightly different sizes. */
  readonly size?: number;
  /**
   * The org's slug. When given, its uploaded logo is attempted from `/api/org-logo/{slug}` and shown over the
   * generated tile (falling back to the tile on 404). Omit to render the generated tile only (no logo fetch).
   */
  readonly slug?: string;
}

export function OrgAvatar({ name, size = 22, slug }: OrgAvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const hue = hueFrom(name);

  // Attempt the logo only when we have a slug to build the URL from.
  const [hasLogo, setHasLogo] = React.useState(slug !== undefined);
  const ref = React.useRef<HTMLImageElement>(null);

  // A shared version bump (a fresh upload just landed) re-attempts the logo even if a prior load 404'd us to
  // the tile — mirrors UserAvatar's shared-version cache-bust.
  const version = React.useSyncExternalStore(
    orgLogoVersion.subscribe,
    orgLogoVersion.get,
    orgLogoVersion.getServer,
  );
  React.useEffect(() => {
    if (slug !== undefined) setHasLogo(true);
  }, [slug, version]);

  // The server-rendered <img> may have finished (404) before hydration attached onError — so on mount, ask the
  // element what already happened (a finished, zero-width image is a failed one). Same subtlety as UserAvatar.
  React.useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setHasLogo(false);
  }, []);

  const src =
    slug !== undefined
      ? `/api/org-logo/${encodeURIComponent(slug)}${version ? `?v=${version}` : ""}`
      : null;

  return (
    <span
      // `aria-hidden`: the org's NAME is always rendered next to this, so announcing the initial as well would
      // read the org twice ("A, Acme"). It is decoration, and says so.
      aria-hidden="true"
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-[5px] font-medium leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        // A fixed saturation/lightness keeps every generated avatar in the same visual family — only the hue
        // varies. The lightness clears white-text contrast on every hue.
        backgroundColor: `hsl(${hue} 52% 42%)`,
      }}
    >
      {initial}
      {hasLogo && src ? (
        <img
          ref={ref}
          src={src}
          alt=""
          width={size}
          height={size}
          className="absolute inset-0 size-full object-cover"
          onError={() => setHasLogo(false)}
        />
      ) : null}
    </span>
  );
}
