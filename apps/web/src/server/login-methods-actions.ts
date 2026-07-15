"use server";

import type { LoginMethod, UnlinkLoginMethodResult } from "@webhook-co/contract";

import { logActionError } from "./action-log";
import { getLoginMethodsBinding } from "./env";
import { verifySession } from "./session";

// The "login methods" (social sign-ins) surface. A user's linked Google/GitHub accounts are `account` rows on
// the global identity realm (webhook_auth only) — distinct from connected apps (OAuth GRANTS). This verifies
// the session and RPCs the LoginMethods binding with its OWN userId; a user only ever sees/unlinks their own.
// Connecting a NEW provider is a browser sign-in (Better Auth's pinned verified-email auto-link does the
// linking), so there's no connect action here — the UI guides the user to sign in with that provider.
//
// dal-gate-allow: user-scoped — gates on verifySession; the identity reads/writes are the caller's own, over RPC.

export type LoginMethodsResult =
  | {
      readonly status: "ok";
      readonly methods: readonly LoginMethod[];
      readonly hasMagicLink: boolean;
    }
  | { readonly status: "unavailable" };

export async function loadLoginMethods(): Promise<LoginMethodsResult> {
  const session = await verifySession();
  const binding = getLoginMethodsBinding();
  if (!binding) return { status: "unavailable" };
  try {
    const snapshot = await binding.list(session.userId);
    return { status: "ok", methods: snapshot.methods, hasMagicLink: snapshot.hasMagicLink };
  } catch (error) {
    logActionError("login_methods.list_rpc", error);
    return { status: "unavailable" };
  }
}

export async function disconnectLoginMethodAction(
  providerId: string,
  accountId: string,
): Promise<UnlinkLoginMethodResult> {
  const session = await verifySession();
  const binding = getLoginMethodsBinding();
  if (!binding) {
    return {
      ok: false,
      error: "Login methods are temporarily unavailable. Please try again shortly.",
    };
  }
  try {
    return await binding.unlink(session.userId, providerId, accountId);
  } catch (error) {
    logActionError("login_methods.unlink_rpc", error);
    return {
      ok: false,
      error: "Login methods are temporarily unavailable. Please try again shortly.",
    };
  }
}
