"use client";

import { Banner, Button, Field } from "@webhook-co/ui";
import * as React from "react";

/**
 * The seam between the device-verification UI and Lane C's device endpoint. The live impl POSTs the
 * user-code and, on success, redirects to `/consent` (where the user approves the grant); the mock
 * resolves. E4 ships {@link mockDeviceActions} so the screen is buildable before Lane C exists; E8
 * swaps in the live client without touching this component.
 */
export interface DeviceActions {
  /** Verify a device user-code. Resolves once accepted; rejects on an unknown/expired code. */
  verifyCode(userCode: string): Promise<void>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Mock seam for E4 — replaced by the live client in E8. Verifies nothing. */
export const mockDeviceActions: DeviceActions = {
  async verifyCode() {
    await wait(500);
  },
};

/** The canonical user-code shape: two groups of four, e.g. `WXYZ-1234`. */
const CODE_RE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;

/** Forgive case, spaces, and a missing dash; canonicalize to `XXXX-XXXX`. */
function normalizeCode(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : cleaned;
}

export function DeviceForm({
  actions = mockDeviceActions,
  initialCode,
}: {
  actions?: DeviceActions;
  /** Pre-fill from `verification_uri_complete`'s `?user_code` — normalized, NOT auto-submitted (RFC 8628
   *  §3.3.1: the user must confirm the code matches their device + click Continue). */
  initialCode?: string;
}) {
  const [code, setCode] = React.useState(() => normalizeCode(initialCode ?? ""));
  const [pending, setPending] = React.useState(false);
  const [verified, setVerified] = React.useState(false);
  const [codeError, setCodeError] = React.useState<string | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const inputRef = React.useRef<HTMLInputElement>(null);

  // When the field is pre-filled (from ?user_code), focus it with the caret at the END — so the user
  // can confirm/edit from where the code stops rather than landing on a selected or start-anchored value.
  // Empty form: leave focus alone. Mount-only (reads the initial DOM value, so no state dep).
  React.useEffect(() => {
    const el = inputRef.current;
    if (el?.value) {
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setCodeError(null);
    setFormError(null);
    const normalized = normalizeCode(code);
    if (!CODE_RE.test(normalized)) {
      setCodeError("Enter the 8-character code shown on your device.");
      return;
    }
    setPending(true);
    try {
      await actions.verifyCode(normalized);
      setVerified(true);
    } catch {
      setFormError("That code isn't valid or has expired. Check your device and try again.");
    } finally {
      setPending(false);
    }
  }

  if (verified) {
    // The live action navigates to the server's redirect (which carries the consent ticket) right
    // after verifyCode resolves; this is the brief confirmation shown until that navigation lands.
    // No manual link to a bare `/consent` — without the ticket it would hit the invalid-request state.
    return (
      <div className="flex flex-col gap-1.5" role="status">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Device verified</h1>
        <p className="leading-snug text-fg-secondary">
          Hang tight — we&apos;re taking you to review the request.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h1 className="text-2xl font-semibold tracking-heading text-fg">Connect a device</h1>
        <p className="leading-snug text-fg-secondary">
          Enter the code shown on your device to continue.
        </p>
      </div>

      {formError ? <Banner tone="danger">{formError}</Banner> : null}

      <form className="flex flex-col gap-3" onSubmit={handleSubmit} noValidate>
        <Field
          ref={inputRef}
          label="Device code"
          placeholder="WXYZ-1234"
          autoComplete="one-time-code"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="font-mono tracking-[0.2em]"
          value={code}
          onChange={(event) => setCode(event.target.value)}
          error={codeError ?? undefined}
          disabled={pending}
        />
        <Button type="submit" disabled={pending}>
          {pending ? "Verifying…" : "Continue"}
        </Button>
      </form>
    </div>
  );
}
