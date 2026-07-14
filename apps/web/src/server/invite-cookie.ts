import "server-only";

import { cookies } from "next/headers";

import { getSessionSecret } from "@/server/env";

// The invite cookie stashes an org-invite's `{ org, token }` on the APP ORIGIN while a brand-new invitee goes
// through login (auth.→app.), so the bearer token never rides an auth-origin URL. Because it holds a secret,
// it is ENCRYPTED + AUTHENTICATED (AES-256-GCM), not merely signed like the session cookie. The AES key is
// HKDF-derived from the existing session secret with a distinct `info` label — no new secret to provision,
// and no key reused across the session token's HMAC and this AEAD.

// 60 min: comfortably longer than a slow first-time signup (a distracted user checking their inbox), while
// still bounding replay of the one-shot stash. The invite itself is separately 7-day + single-use.
const TTL_MS = 60 * 60_000;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function aesKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(secret), "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: enc.encode("wh-invite-cookie-v1"),
    },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypt `{ org, token }` (+ the TTL_MS embedded expiry) into a base64url `iv‖ciphertext‖tag`. */
export async function sealInvitePayload(
  payload: { org: string; token: string },
  secret: string,
  nowMs: number,
): Promise<string> {
  const key = await aesKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const pt = enc.encode(
    JSON.stringify({ org: payload.org, token: payload.token, exp: nowMs + TTL_MS }),
  );
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, pt));
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return b64urlEncode(out);
}

/** Decrypt + verify; null on tamper, wrong key, expiry, or malformed input. */
export async function openInvitePayload(
  sealed: string,
  secret: string,
  nowMs: number,
): Promise<{ org: string; token: string } | null> {
  try {
    const raw = b64urlDecode(sealed);
    if (raw.length < 13) return null; // 12-byte iv + at least some ciphertext
    const key = await aesKey(secret);
    // Copy into fresh ArrayBuffer-backed views — `subarray()` yields Uint8Array<ArrayBufferLike>, which the
    // stricter Workers/TS lib does not accept as a BufferSource.
    const iv = new Uint8Array(12);
    iv.set(raw.subarray(0, 12));
    const body = new Uint8Array(raw.length - 12);
    body.set(raw.subarray(12));
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, body);
    const obj = JSON.parse(dec.decode(pt)) as { org?: unknown; token?: unknown; exp?: unknown };
    if (
      typeof obj.org !== "string" ||
      typeof obj.token !== "string" ||
      typeof obj.exp !== "number"
    ) {
      return null;
    }
    if (nowMs > obj.exp) return null;
    return { org: obj.org, token: obj.token };
  } catch {
    return null;
  }
}

// ── Cookie accessors ────────────────────────────────────────────────────────────────────────────────────
// Mirror the session cookie's `__Host-` + Secure coupling (see session-cookie.ts): the prefix REQUIRES Secure,
// so name and attributes are derived together. HttpOnly (no JS read), SameSite=Lax (survives the top-level
// nav back from the auth origin), Path=/, short Max-Age.

export function inviteCookieName(nodeEnv: string | undefined = process.env.NODE_ENV): string {
  return nodeEnv === "production" ? "__Host-wh_invite" : "wh_invite";
}

function inviteCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
  } as const;
}

export async function setInviteCookie(payload: { org: string; token: string }): Promise<void> {
  const sealed = await sealInvitePayload(payload, await getSessionSecret(), Date.now());
  (await cookies()).set(inviteCookieName(), sealed, {
    ...inviteCookieOptions(),
    maxAge: TTL_MS / 1000,
  });
}

export async function readInviteCookie(): Promise<{ org: string; token: string } | null> {
  const c = (await cookies()).get(inviteCookieName());
  if (!c) return null;
  return openInvitePayload(c.value, await getSessionSecret(), Date.now());
}

export async function clearInviteCookie(): Promise<void> {
  (await cookies()).delete({ name: inviteCookieName(), ...inviteCookieOptions() });
}
