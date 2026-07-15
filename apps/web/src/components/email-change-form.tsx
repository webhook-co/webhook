"use client";

import { Banner, Button, Field } from "@webhook-co/ui";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { CommitEmailChangeResult, StartEmailChangeResult } from "@webhook-co/contract";

export interface EmailChangeFormProps {
  readonly currentEmail: string;
  readonly start: (formData: FormData) => Promise<StartEmailChangeResult>;
  readonly commit: (formData: FormData) => Promise<CommitEmailChangeResult>;
}

/**
 * The two-step email-change ceremony. Step 1: enter the new address → a 6-digit code is sent to your CURRENT
 * email (step-up — it proves you control the address on record). Step 2: enter the code → the change commits,
 * every other session is signed out, and this browser's session updates to the new address.
 */
export function EmailChangeForm({ currentEmail, start, commit }: EmailChangeFormProps) {
  const router = useRouter();
  const [step, setStep] = useState<"idle" | "code">("idle");
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function sendCode() {
    const target = newEmail.trim();
    if (!target || pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("email", target);
    startTransition(async () => {
      const res = await start(fd);
      if (res.ok) setStep("code");
      else setError(res.error);
    });
  }

  function confirm() {
    if (!code.trim() || pending) return;
    setError(null);
    const fd = new FormData();
    fd.set("code", code.trim());
    startTransition(async () => {
      const res = await commit(fd);
      if (res.ok) {
        setCommitted(res.newEmail);
        router.refresh(); // this browser's cookie was re-minted server-side; re-render with the new email
      } else {
        setError(res.error);
        // A locked/expired/no_pending state means starting over.
        if (res.reason === "expired" || res.reason === "no_pending" || res.reason === "locked") {
          setStep("idle");
          setCode("");
        }
      }
    });
  }

  if (committed) {
    return (
      <div className="flex flex-col gap-2" role="status">
        <Banner tone="ok">
          Your email is now <span className="font-medium">{committed}</span>. For your security,
          we&apos;ve revoked your other sign-ins — you&apos;ll need to sign in again on other
          devices (any session still active there expires within 7 days).
        </Banner>
      </div>
    );
  }

  if (step === "code") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-fg-secondary">
          Enter the 6-digit code we sent to{" "}
          <span className="font-medium text-fg">{currentEmail}</span> to confirm the change to{" "}
          <span className="font-medium text-fg">{newEmail}</span>.
        </p>
        <Field
          label="Verification code"
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          disabled={pending}
          autoFocus
        />
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <div className="flex gap-2">
          <Button onClick={confirm} loading={pending} disabled={code.trim().length < 6 || pending}>
            {pending ? "Confirming…" : "Confirm change"}
          </Button>
          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setStep("idle");
              setCode("");
              setError(null);
            }}
            disabled={pending}
          >
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-secondary">
        Your email is <span className="font-medium text-fg">{currentEmail}</span>. To change it,
        enter the new address — we&apos;ll email a code to your current one to confirm it&apos;s
        you.
      </p>
      <Field
        label="New email"
        type="email"
        value={newEmail}
        onChange={(e) => setNewEmail(e.target.value)}
        placeholder="you@newdomain.com"
        disabled={pending}
        autoComplete="email"
        spellCheck={false}
      />
      {error ? <Banner tone="danger">{error}</Banner> : null}
      <div>
        <Button onClick={sendCode} loading={pending} disabled={!newEmail.trim() || pending}>
          {pending ? "Sending…" : "Send code"}
        </Button>
      </div>
    </div>
  );
}
