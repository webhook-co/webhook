/**
 * The alert delivery channel: a plain Resend HTTPS call.
 *
 * WHY NOT `message.reply()` / `message.forward()`: this Worker must never send via Cloudflare Email
 * Routing. Doing so makes Cloudflare send as `wbhk.my`, which would force `include:_spf.mx.cloudflare.net`
 * onto that zone and undo the Phase 3 anti-spoof posture (`v=spf1 -all`). An outbound HTTPS request to
 * Resend touches none of that — it sends as `mail.webhook.co`, an already-verified sending domain, and
 * needs no capability change on it (a verified domain accepts any local part).
 *
 * ⚠️ KNOWN RESIDUAL — the alerter shares a failure domain with one of the lanes it watches. If
 * `mail.webhook.co` itself falls out of DMARC alignment, this alert is exactly the mail that gets
 * rejected. That is accepted deliberately rather than overlooked: a `mail.webhook.co` failure also breaks
 * magic-link login, which announces itself within minutes. The lanes that fail SILENTLY — the apex and
 * `billing.` — are the ones this channel still reaches. Revisit only if a second, independent channel is
 * ever warranted.
 */

/** The subset of `fetch` this module needs, so tests can supply a double without touching the network. */
export type AlertTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<Response>;

export interface AlertChannel {
  apiKey: string;
  from: string;
  to: string;
}

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * Deliver one alert. RESOLVES only on a 2xx.
 *
 * The throw-on-failure contract is load-bearing: the caller advances its "already alerted" cursor only
 * after this resolves, so a swallowed error here would silently skip records nobody was ever told about.
 */
export async function sendAlert(
  channel: AlertChannel,
  subject: string,
  text: string,
  transport: AlertTransport,
): Promise<void> {
  const res = await transport(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${channel.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: channel.from,
      to: [channel.to],
      subject,
      text,
    }),
  });

  if (!res.ok) {
    // Include the provider's own body: "403" alone cannot distinguish an unverified domain from a
    // revoked key, and those have completely different fixes.
    const detail = await res.text().catch(() => "");
    throw new Error(`resend send failed: ${res.status} ${detail}`.trim());
  }
}
