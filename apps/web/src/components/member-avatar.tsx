"use client";

import * as React from "react";

function initials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface MemberAvatarProps {
  readonly name: string;
  readonly email: string;
  /** The org slug + the member's user id — together they build the membership-gated serve URL. */
  readonly slug: string;
  readonly userId: string;
  readonly size?: number;
}

/**
 * A co-member's face on the Team page, or their initials. The image comes from the membership-gated
 * `/api/org/{slug}/member-avatar/{userId}` (OUR origin — the CSP stays `img-src 'self'`); a member with no
 * avatar answers 404, the `<img>` fires `error`, and the initials underneath are all that's left.
 *
 * Like `UserAvatar`, the `<img>` is server-rendered, so a 404 can land before hydration attaches `onError` —
 * hence the mount-time `complete && naturalWidth === 0` check (a finished, zero-width image is a failed one).
 * This is separate from `UserAvatar` on purpose: it serves OTHER users (no shared cache-bust version), and its
 * URL is member-scoped rather than the session-derived `/api/avatar`.
 */
export function MemberAvatar({ name, email, slug, userId, size = 28 }: MemberAvatarProps) {
  const [hasImage, setHasImage] = React.useState(true);
  const ref = React.useRef<HTMLImageElement>(null);

  React.useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setHasImage(false);
  }, []);

  const src = `/api/org/${encodeURIComponent(slug)}/member-avatar/${encodeURIComponent(userId)}`;

  return (
    <span
      aria-hidden="true"
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-hairline bg-surface-sunken font-medium text-fg-secondary"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name, email)}
      {hasImage ? (
        <img
          ref={ref}
          src={src}
          alt=""
          width={size}
          height={size}
          className="absolute inset-0 size-full object-cover"
          onError={() => setHasImage(false)}
        />
      ) : null}
    </span>
  );
}
