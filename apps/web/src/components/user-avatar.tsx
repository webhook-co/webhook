"use client";

import * as React from "react";

function initials(name: string, email: string): string {
  const source = name.trim() || email.trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

export interface UserAvatarProps {
  readonly name: string;
  readonly email: string;
  /** Pixels. */
  readonly size?: number;
  readonly className?: string;
}

/**
 * The signed-in user's face, or their initials.
 *
 * The image comes from `/api/avatar` — OUR origin, always. That route reads the session, resolves the
 * provider's avatar (Google/GitHub) or falls back to Gravatar, and proxies the bytes. The browser never talks
 * to a third party, so the CSP stays `img-src 'self'` and Gravatar never learns the user's IP or which page
 * they are on.
 *
 * ── The fallback is the normal case, not the error case ─────────────────────────────────────────────────
 *
 * Most people do not have a Gravatar. The route answers `204 No Content` for them (it asks Gravatar for
 * `d=404` precisely so it can tell the difference between "no avatar" and "here is a grey silhouette"), and a
 * 204 makes the `<img>` fire `error`. So `error` here means "this user has no picture" far more often than it
 * means "something broke" — which is why it swaps to initials silently rather than showing a broken-image
 * icon or an empty box.
 *
 * The initials render UNDERNEATH from the first paint, and the image sits on top once it loads. That ordering
 * is what stops the flicker: there is never a frame with nothing in it.
 */
export function UserAvatar({ name, email, size = 26, className }: UserAvatarProps) {
  const [hasImage, setHasImage] = React.useState(true);
  const ref = React.useRef<HTMLImageElement>(null);

  // `onError` ALONE IS NOT ENOUGH, and this is the whole subtlety of the component.
  //
  // The <img> is SERVER-RENDERED. The browser sees it in the HTML and starts loading it during parse — long
  // before React hydrates and attaches the onError listener. For the common case (a user with no Gravatar) the
  // request 404s almost immediately, so the error event fires into the void: nothing is listening yet, and the
  // handler that arrives a moment later is never called. The broken-image glyph then sits on the page forever.
  //
  // I shipped exactly that, and the account page showed a little torn-picture icon on top of the initials. No
  // test could have caught it: jsdom does not load images, so `onError` never fires there either way, and the
  // suite was perfectly green.
  //
  // So on mount we ASK the element what already happened. A finished-but-zero-width image is a failed one.
  React.useEffect(() => {
    const img = ref.current;
    if (img && img.complete && img.naturalWidth === 0) setHasImage(false);
  }, []);

  return (
    <span
      // Decorative: the name is always rendered beside this, and announcing the initials as well would read
      // the user twice ("DK, Dana Kessler").
      aria-hidden="true"
      className={`relative grid shrink-0 place-items-center overflow-hidden rounded-full border border-hairline bg-surface-sunken font-medium text-fg-secondary ${className ?? ""}`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.38) }}
    >
      {initials(name, email)}
      {hasImage ? (
        // A plain <img>, not next/image. next/image wants a loader and remote-pattern config for what is
        // already a same-origin, server-proxied, privately-cached route returning one small fixed-size image.
        // It would add machinery and change nothing.
        <img
          ref={ref}
          src="/api/avatar"
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
