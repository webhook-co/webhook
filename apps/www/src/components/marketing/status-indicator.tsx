import { cn } from "@webhook-co/ui";

import { LINKS } from "@/lib/links";
import { focusRing } from "@/lib/styles";

/**
 * The live status indicator in the footer.
 *
 * This replaces the hardcoded "All systems operational" string that used to sit here next to a green
 * dot with nothing behind it. A health indicator that isn't wired to a health check is a lie told in
 * the most trustworthy-looking way available, so it was removed until a real status page existed.
 * One does now, and this is wired to it.
 *
 * WHY NOT PHARE'S IFRAME EMBED. The footer renders on every page, so an embed would put a
 * third-party frame on every pageview of the site whose whole pitch is reliability — and it would go
 * blank exactly when Phare is having a bad day, which is the moment someone is looking at it. It
 * would also hardcode hex colours next to a design system built on tokens, and add a third-party
 * request to a site that asks visitors for consent. Fetching the JSON server-side avoids all four.
 *
 * FAILURE MODE: renders NOTHING. If the fetch fails, times out, or returns something unexpected, the
 * footer looks exactly as it did before. An indicator that cannot be trusted should be absent rather
 * than apologetic — and a stale "operational" would be worse than either.
 */

/** Phare's shields-endpoint document. Only the two fields we actually render are modelled. */
export interface StatusBadge {
  readonly message: string;
  readonly color: string;
}

const STATUS_URL = "https://status.webhook.co/shield-badges/status.json";

/** How long a verdict is reused. Short enough to stay honest, long enough not to hammer the vendor. */
const REVALIDATE_SECONDS = 60;

/**
 * A colour we are willing to put in a `style` attribute.
 *
 * The value crosses a trust boundary — a third party chooses it — so it is matched against a strict
 * hex pattern rather than interpolated. Anything else falls back to `currentColor`, which renders a
 * muted dot instead of letting vendor-controlled text reach CSS.
 */
export function safeColor(color: unknown): string {
  return typeof color === "string" && /^#[0-9a-f]{3,8}$/i.test(color) ? color : "currentColor";
}

/** Keep the label short; a vendor string must never be able to reflow the footer. */
export function safeMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const trimmed = message.trim();
  return trimmed.length > 0 && trimmed.length <= 40 ? trimmed : null;
}

/** Fetch the current status, resolving to null on ANY failure rather than throwing into the page. */
export async function fetchStatus(fetchImpl: typeof fetch = fetch): Promise<StatusBadge | null> {
  try {
    const res = await fetchImpl(STATUS_URL, {
      next: { revalidate: REVALIDATE_SECONDS },
      signal: AbortSignal.timeout(3_000),
    } as RequestInit);
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const { message, color } = body as { message?: unknown; color?: unknown };
    const safe = safeMessage(message);
    return safe === null ? null : { message: safe, color: safeColor(color) };
  } catch {
    // Swallowed on purpose — the footer must render whether or not the status vendor answers.
    return null;
  }
}

/**
 * PURE and SYNCHRONOUS on purpose. Making this async made it an async component inside `Footer`,
 * which broke every test that renders the footer — and, worse, would have made the whole footer a
 * suspense boundary. The fetch belongs at the page boundary; this only renders what it is handed,
 * so a caller with nothing to show (the default) changes no markup at all.
 */
export function StatusIndicator({
  status,
  className,
}: {
  status: StatusBadge | null;
  className?: string;
}) {
  if (status === null) return null;

  return (
    <a
      href={LINKS.status}
      className={cn(
        focusRing,
        "inline-flex items-center gap-2 rounded-control text-sm text-fg-muted transition-colors hover:text-fg",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: status.color }}
      />
      {status.message}
    </a>
  );
}
