"use client";

// The interactive webhook-signature verifier. Runs the REAL verification engine (webhooks-spec) entirely
// in the browser via `runVerify` — the secret, payload, and signature NEVER leave the page (this is a
// Next static export: there is no server endpoint to send them to; nothing is written to storage, the URL,
// or the network). Every user-supplied value renders as an INERT React text node (never HTML), which is
// the XSS control (asserted in verify-tool.test.tsx). Inputs are driven by the selected provider's recipe.

import { Button, cn, Combobox, type ComboboxOption, providerDisplayName } from "@webhook-co/ui";
import {
  CLIENT_VERIFIABLE_RECIPES,
  getRecipe,
  type RecipeDescriptor,
} from "@webhook-co/webhooks-recipes";
import { useEffect, useMemo, useState } from "react";

import { PROVIDER_ENTRIES } from "@/components/marketing/provider-entries";
import { ProviderMark } from "@/components/marketing/provider-mark";

import { runVerify, type NormalizedResult } from "./verify-runner";

const ENTRY_BY_SLUG = new Map(PROVIDER_ENTRIES.map((e) => [e.slug, e]));

/**
 * The provider picker's options — the same shape the dashboard's provider dropdown uses: the shared
 * `Combobox` with a per-option brand mark. Built once at module scope rather than per render, because
 * it is 122 options each carrying an icon element.
 *
 * Every client-verifiable provider resolves to a REAL logo (65 inline CC0 vectors, 57 committed
 * favicons — verified, no gaps), so nothing here falls back to a monogram. `ProviderMark` is the
 * static-site resolver; the dashboard's favicon-proxy route does not exist on this host.
 */
const PROVIDER_OPTIONS: readonly ComboboxOption[] = [...CLIENT_VERIFIABLE_RECIPES]
  .sort((a, b) => providerDisplayName(a.slug).localeCompare(providerDisplayName(b.slug)))
  .map((r) => {
    const entry = ENTRY_BY_SLUG.get(r.slug);
    return {
      value: r.slug,
      label: providerDisplayName(r.slug),
      ...(entry ? { icon: <ProviderMark entry={entry} size={16} /> } : {}),
    };
  });

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-fg">{label}</span>
      {hint ? <span className="mb-1.5 block text-xs text-fg-muted">{hint}</span> : null}
      {children}
    </label>
  );
}

/**
 * The name of the timestamp HEADER the user must paste — but only for schemes that carry the timestamp
 * in its own header. `verifierInputs` includes "timestamp" exactly then; schemes that fold the timestamp
 * into the signature value (Stripe's `t=`, JWT `iat`) must NOT ask for a header that doesn't exist.
 * `timestamp.source` is generated prose naming it in backticks ("the `x-slack-request-timestamp` header").
 */
function timestampHeaderHint(recipe: RecipeDescriptor): string | null {
  if (!recipe.verifierInputs.includes("timestamp")) return null;
  const named = recipe.timestamp ? /`([^`]+)`/.exec(recipe.timestamp.source) : null;
  return named?.[1] ?? "the timestamp header";
}

const inputCls =
  "w-full rounded-control border border-hairline bg-surface-sunken px-3 py-2 font-mono text-sm text-fg placeholder:text-fg-faint focus:border-info focus:outline-none";

export function VerifyTool({ initialProvider }: { initialProvider?: string }) {
  const [slug, setSlug] = useState(
    initialProvider && getRecipe(initialProvider)?.clientVerifiable ? initialProvider : "stripe",
  );
  const recipe = getRecipe(slug)!;

  const [secret, setSecret] = useState("");
  const [payload, setPayload] = useState("");
  const [signature, setSignature] = useState("");
  const [extraHeaders, setExtraHeaders] = useState("");
  const [requestUrl, setRequestUrl] = useState("");
  const [method, setMethod] = useState("POST");
  const [verificationTime, setVerificationTime] = useState("");
  const [showSecret, setShowSecret] = useState(false);
  const [result, setResult] = useState<NormalizedResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [ed25519Supported, setEd25519Supported] = useState<boolean | null>(null);

  const isSigInBody =
    recipe.signatureLocation === "json-body" || recipe.signatureLocation === "form-body";
  const needsTimestampNote = recipe.timestamp !== null;
  const needsUrl = recipe.verifierInputs.includes("requestUrl");
  const needsMethod = recipe.verifierInputs.includes("method");
  const signedHeaders = recipe.signedHeaders ?? [];
  const isEd25519 = recipe.archetype === "asymmetric" && /ed25519/i.test(recipe.algorithm);

  // Feature-detect Ed25519 once (unsupported in older Safari/Firefox) so we can WARN rather than report a
  // valid Discord/Telnyx/Keygen signature as "invalid".
  useEffect(() => {
    let alive = true;
    crypto.subtle
      .importKey("raw", new Uint8Array(32), { name: "Ed25519" }, false, ["verify"])
      .then(() => alive && setEd25519Supported(true))
      .catch(() => alive && setEd25519Supported(false));
    return () => {
      alive = false;
    };
  }, []);

  // Clear the result (and stale inputs' output) when switching providers.
  useEffect(() => {
    setResult(null);
  }, [slug]);

  const extraHeaderHint = useMemo(() => {
    const hints: string[] = [];
    const tsHeader = timestampHeaderHint(recipe);
    if (tsHeader) hints.push(tsHeader);
    for (const h of signedHeaders) hints.push(h);
    return hints;
  }, [recipe, signedHeaders]);

  async function onVerify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    const r = await runVerify(
      {
        provider: slug,
        payload,
        secret,
        signatureValue: signature,
        extraHeaders,
        requestUrl: needsUrl ? requestUrl : undefined,
        method: needsMethod ? method : undefined,
        verificationTime: verificationTime || undefined,
      },
      recipe,
    );
    setResult(r);
    setBusy(false);
  }

  const secretLabel =
    recipe.archetype === "asymmetric"
      ? "Public key"
      : recipe.archetype === "jwt"
        ? "Signing key"
        : "Signing secret";

  return (
    <form onSubmit={onVerify} className="grid gap-5" aria-label="Webhook signature verifier">
      {/* Not wrapped in `Field`: the Combobox is a button + popover that names itself via its `label`
          prop, so a surrounding <label> would announce the control twice. The heading is a plain span. */}
      <div className="block">
        <span className="mb-1 block text-sm font-medium text-fg">Provider</span>
        <Combobox
          label="Provider"
          options={PROVIDER_OPTIONS}
          value={slug}
          onChange={setSlug}
          searchPlaceholder={`Search ${PROVIDER_OPTIONS.length} providers…`}
          // The shared trigger is `inline-flex` (content-width), which is right in the dashboard's
          // toolbars but reads as a stray narrow control in this full-width form. Widening it also
          // widens the popover, which follows `--radix-popover-trigger-width`.
          className="w-full"
        />
      </div>

      {isEd25519 && ed25519Supported === false ? (
        <p className="rounded-control border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-warn">
          Your browser doesn&apos;t support Ed25519 in Web Crypto, so a valid{" "}
          {providerDisplayName(slug)} signature may show as invalid here. Try a current Chrome/Edge,
          or verify server-side.
        </p>
      ) : null}

      <Field label={secretLabel} hint="Stays in your browser — it is never sent anywhere or saved.">
        <div className="flex gap-2">
          <input
            className={inputCls}
            type={showSecret ? "text" : "password"}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            data-1p-ignore="true"
            data-lpignore="true"
            placeholder={recipe.archetype === "asymmetric" ? "base64/PEM public key" : "whsec_…"}
          />
          <Button type="button" variant="secondary" onClick={() => setShowSecret((s) => !s)}>
            {showSecret ? "Hide" : "Show"}
          </Button>
        </div>
      </Field>

      <Field
        label="Payload (raw request body)"
        hint="Paste the exact bytes your endpoint received."
      >
        <textarea
          className={cn(inputCls, "min-h-28 resize-y")}
          value={payload}
          onChange={(e) => setPayload(e.target.value)}
          spellCheck={false}
          placeholder="{ … }"
        />
      </Field>

      {isSigInBody ? (
        <p className="text-sm text-fg-muted">
          {providerDisplayName(slug)} carries the signature inside the request body — no separate
          header needed.
        </p>
      ) : (
        <Field label={`Signature header — ${recipe.signatureHeader}`}>
          <input
            className={inputCls}
            value={signature}
            onChange={(e) => setSignature(e.target.value)}
            spellCheck={false}
            placeholder={
              recipe.signatureValuePrefix ? `${recipe.signatureValuePrefix}…` : "signature value"
            }
          />
        </Field>
      )}

      {extraHeaderHint.length > 0 ? (
        <Field
          label="Other signed headers"
          hint={
            <>
              One <code>Name: value</code> per line. Include:{" "}
              {extraHeaderHint.map((h, i) => (
                <span key={h}>
                  {i > 0 ? ", " : ""}
                  <code>{h}</code>
                </span>
              ))}
              .
            </>
          }
        >
          <textarea
            className={cn(inputCls, "min-h-16 resize-y")}
            value={extraHeaders}
            onChange={(e) => setExtraHeaders(e.target.value)}
            spellCheck={false}
            placeholder={
              extraHeaderHint[0] && !extraHeaderHint[0].includes(" ")
                ? `${extraHeaderHint[0]}: …`
                : "X-…-Timestamp: 1700000000"
            }
          />
        </Field>
      ) : null}

      {needsUrl || needsMethod ? (
        <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
          {needsUrl ? (
            <Field label="Request URL" hint="This provider signs the ingest URL.">
              <input
                className={inputCls}
                value={requestUrl}
                onChange={(e) => setRequestUrl(e.target.value)}
                spellCheck={false}
                placeholder="https://…"
              />
            </Field>
          ) : null}
          {needsMethod ? (
            <Field label="Method">
              <input
                className={cn(inputCls, "w-24")}
                value={method}
                onChange={(e) => setMethod(e.target.value)}
              />
            </Field>
          ) : null}
        </div>
      ) : null}

      {needsTimestampNote ? (
        <Field
          label="Verification time (optional)"
          hint="This scheme signs a timestamp and enforces a replay window. To test the signature itself on an older event, set this near the event's time."
        >
          <input
            className={cn(inputCls, "font-sans")}
            type="datetime-local"
            value={verificationTime}
            onChange={(e) => setVerificationTime(e.target.value)}
          />
        </Field>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={busy}>
          {busy ? "Verifying…" : "Verify signature"}
        </Button>
        <span className="text-xs text-fg-muted">Runs entirely in your browser.</span>
      </div>

      {result ? (
        <output
          className={cn(
            "rounded-control border px-4 py-3",
            result.status === "verified"
              ? "border-ok/40 bg-ok/10"
              : result.status === "failed"
                ? "border-danger/40 bg-danger/10"
                : "border-warn/40 bg-warn/10",
          )}
        >
          <p
            className={cn(
              "text-sm font-semibold",
              result.status === "verified"
                ? "text-ok"
                : result.status === "failed"
                  ? "text-danger"
                  : "text-warn",
            )}
          >
            {result.status === "verified"
              ? "✓ Verified"
              : result.status === "failed"
                ? `✗ Not verified${result.code ? ` — ${result.code}` : ""}`
                : "Couldn't verify"}
          </p>
          <p className="mt-1 text-sm text-fg-secondary">{result.explanation}</p>
        </output>
      ) : null}
    </form>
  );
}
