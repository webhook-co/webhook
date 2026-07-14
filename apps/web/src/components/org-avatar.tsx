import * as React from "react";

/**
 * A deterministic, generated avatar for an organization: its initial on a tinted square.
 *
 * No image, and none is coming. An org has no photo to show — and inventing an upload for one would be a whole
 * feature (storage, moderation, a fallback anyway) to solve a problem nobody has. What the picker actually
 * needs is something the eye can lock onto so that "which org am I in?" is answered pre-attentively, before
 * you read the word. A stable colour does that; a grey square does not.
 *
 * The hue is DERIVED from the name, so it is stable across sessions, machines and renders without storing
 * anything: the same org is always the same colour, and two orgs are unlikely to collide. Nothing here is
 * security-relevant — it must not be mistaken for identity — so a cheap hash is exactly right.
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
}

export function OrgAvatar({ name, size = 22 }: OrgAvatarProps) {
  const initial = name.trim().charAt(0).toUpperCase() || "?";
  const hue = hueFrom(name);

  return (
    <span
      // `aria-hidden`: the org's NAME is always rendered next to this, so announcing the initial as well would
      // read the org twice ("A, Acme"). It is decoration, and says so.
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-[5px] font-medium leading-none text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.5),
        // A fixed saturation/lightness keeps every generated avatar in the same visual family — the hue is the
        // only thing that varies, so the set reads as one system rather than a bag of random colours. The
        // lightness is chosen so white text clears contrast on every hue, not just the dark ones.
        backgroundColor: `hsl(${hue} 52% 42%)`,
      }}
    >
      {initial}
    </span>
  );
}
