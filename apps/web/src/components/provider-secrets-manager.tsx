"use client";

import {
  Banner,
  Button,
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Field,
  Label,
  providerDisplayName,
  Select,
  StatusPill,
  type StatusTone,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@webhook-co/ui";
import {
  BRAINTREE_PUBLIC_KEY_PROVIDERS,
  PROVIDERS,
  VERIFY_TOKEN_PROVIDERS,
  type Provider,
  type ProviderSecretKind,
} from "@webhook-co/shared";
import * as React from "react";
import { flushSync } from "react-dom";

import { formatDate } from "@/lib/format";
import type {
  AddProviderSecretResult,
  ProviderSecretActionResult,
} from "@/server/provider-secret-actions";
import type { ProviderSecretItem } from "@/server/provider-secrets";

// The provider-secret management surface: an add form + a list with per-row revoke. A provider secret is the
// inbound-VERIFICATION material for an endpoint (a Stripe webhook secret, a Meta verify token, …). It is
// WRITE-ONLY: unlike a signing secret there is NO reveal — we seal it immediately and never show it again, so
// there is no OneTimeSecretDialog here, only a metadata row. Mirrors replay-destinations-manager's patterns —
// optimistic row mutations, a destructive confirm, inline `<Banner>` feedback (there is no Toast), and a
// synchronous `pendingRef` latch so a double-click can't fire a mutation twice.

/** The kinds a provider offers: always signing_secret; verify_token / braintree_public_key only where valid. */
const KIND_LABELS: Record<ProviderSecretKind, string> = {
  signing_secret: "Signing secret",
  verify_token: "Verify token",
  braintree_public_key: "Braintree public key",
};

function kindsForProvider(provider: Provider): ProviderSecretKind[] {
  const kinds: ProviderSecretKind[] = ["signing_secret"];
  if (VERIFY_TOKEN_PROVIDERS.has(provider)) kinds.push("verify_token");
  if (BRAINTREE_PUBLIC_KEY_PROVIDERS.has(provider)) kinds.push("braintree_public_key");
  return kinds;
}

/** The tone a provider-secret status earns: active→ok, retiring→warn, revoked→neutral. */
function statusTone(status: string): StatusTone {
  if (status === "active") return "ok";
  if (status === "retiring") return "warn";
  return "neutral";
}

export interface ProviderSecretsManagerProps {
  endpointId: string;
  initial: readonly ProviderSecretItem[];
  add: (input: {
    endpointId: string;
    provider: string;
    kind: string;
    secret: string;
    label?: string;
  }) => Promise<AddProviderSecretResult>;
  revoke: (endpointId: string, secretId: string) => Promise<ProviderSecretActionResult>;
}

export function ProviderSecretsManager({
  endpointId,
  initial,
  add,
  revoke,
}: ProviderSecretsManagerProps) {
  const [secrets, setSecrets] = React.useState<readonly ProviderSecretItem[]>(initial);
  // Rows added optimistically this session — their `createdAt` is a placeholder (the server, not the browser
  // clock, is the source of truth for the added time), so we render "Just now" until the server row lands.
  const [optimisticIds, setOptimisticIds] = React.useState<ReadonlySet<string>>(new Set());
  // Reconcile to a fresh server-provided `initial` WITHOUT remounting (mirrors the other managers): an
  // out-of-band change (e.g. a revoke from another surface) surfaces on the next render, not only on reload.
  // The revalidated list carries authoritative timestamps, so the optimistic set clears with it.
  const [seeded, setSeeded] = React.useState(initial);
  if (seeded !== initial) {
    setSeeded(initial);
    setSecrets(initial);
    setOptimisticIds(new Set());
  }

  // Add-form state.
  const [provider, setProvider] = React.useState<Provider>(PROVIDERS[0]);
  const [kind, setKind] = React.useState<ProviderSecretKind>("signing_secret");
  const [secret, setSecret] = React.useState("");
  const [label, setLabel] = React.useState("");
  const [formError, setFormError] = React.useState<string | null>(null);

  // Row-revoke error, surfaced inside the confirm dialog (a page-level Banner would sit behind the modal).
  const [removing, setRemoving] = React.useState<ProviderSecretItem | null>(null);
  const [removeError, setRemoveError] = React.useState<string | null>(null);

  // A synchronous in-flight latch keyed by operation — `pending` state re-renders a frame late, so it can't
  // block a same-tick double-submit. `busy` mirrors it for disabling.
  const pendingRef = React.useRef<Set<string>>(new Set());
  const [busy, setBusy] = React.useState<ReadonlySet<string>>(new Set());
  const isBusy = (key: string) => busy.has(key);

  async function guard(key: string, run: () => Promise<void>): Promise<void> {
    if (pendingRef.current.has(key)) return; // synchronous double-fire guard
    pendingRef.current.add(key);
    setBusy((prev) => new Set(prev).add(key));
    try {
      await run();
    } finally {
      pendingRef.current.delete(key);
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  }

  const availableKinds = kindsForProvider(provider);
  const creating = isBusy("create");
  const canCreate = secret.trim() !== "" && !creating;

  function handleProviderChange(next: Provider) {
    setProvider(next);
    if (formError) setFormError(null);
    // A kind that the new provider doesn't offer (e.g. verify_token after switching off Meta) can't be
    // submitted — snap back to the always-available signing_secret so the form stays coherent.
    if (!kindsForProvider(next).includes(kind)) setKind("signing_secret");
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    await guard("create", async () => {
      setFormError(null);
      try {
        const result = await add({
          endpointId,
          provider,
          kind,
          secret,
          label: label.trim() || undefined,
        });
        if (!result.ok) {
          setFormError(result.error);
          return;
        }
        // No reveal: prepend a METADATA row only. We keep the label the operator typed; the server is the
        // source of truth for the row (incl. its real createdAt) on the next revalidation. `createdAt` here is
        // a placeholder never shown — the row is flagged optimistic so the Added cell reads "Just now".
        const row: ProviderSecretItem = {
          id: result.secret.id,
          provider: result.secret.provider,
          status: result.secret.status as ProviderSecretItem["status"],
          label: label.trim() || null,
          createdAt: new Date(0),
        };
        setSecrets((prev) => [row, ...prev]);
        setOptimisticIds((prev) => new Set(prev).add(row.id));
        // Clear the secret from component state the instant it's sealed — it must not linger.
        setSecret("");
        setLabel("");
      } catch {
        setFormError("We couldn't save the secret. Please try again.");
      }
    });
  }

  function requestRemove(item: ProviderSecretItem) {
    setRemoveError(null);
    setRemoving(item);
  }

  function closeRemove() {
    setRemoving(null);
    setRemoveError(null);
  }

  async function confirmRemove() {
    const item = removing;
    if (!item) return;
    await guard(`row:${item.id}`, async () => {
      setRemoveError(null);
      try {
        const result = await revoke(endpointId, item.id);
        // `gone` (already revoked elsewhere / unknown) is not a dead-end: the secret is already in its terminal
        // state, so reconcile the row to revoked exactly as a success would rather than stranding a live-looking
        // row behind an error. Any other failure stays in the dialog for a retry.
        if (!result.ok && !result.gone) {
          setRemoveError(result.error);
          return;
        }
        // Close the confirm dialog synchronously BEFORE mutating the row so Radix runs its scroll-lock
        // cleanup on the still-present modal (mirrors the destinations manager).
        flushSync(() => closeRemove());
        // Mark the row revoked in place (history is retained — the operator sees the full rotation trail).
        setSecrets((prev) => prev.map((s) => (s.id === item.id ? { ...s, status: "revoked" } : s)));
      } catch {
        setRemoveError("We couldn't revoke the secret. Please try again.");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider secrets</CardTitle>
        <CardDescription>
          Add a provider&apos;s signing secret so we can verify inbound webhooks to this endpoint.
          We seal it immediately — you won&apos;t see it again.
        </CardDescription>
      </CardHeader>

      <div className="flex flex-col gap-6 px-6 pb-6">
        <form
          onSubmit={handleCreate}
          className="flex flex-col gap-4 rounded-card border border-hairline bg-surface-sunken p-5"
        >
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="provider-secret-provider">Provider</Label>
              <Select
                id="provider-secret-provider"
                value={provider}
                disabled={creating}
                onChange={(e) => handleProviderChange(e.target.value as Provider)}
              >
                {PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {providerDisplayName(p)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="flex flex-1 flex-col gap-1.5">
              <Label htmlFor="provider-secret-kind">Secret type</Label>
              <Select
                id="provider-secret-kind"
                value={kind}
                disabled={creating}
                onChange={(e) => {
                  setKind(e.target.value as ProviderSecretKind);
                  if (formError) setFormError(null);
                }}
              >
                {availableKinds.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
            <Field
              label="Secret"
              type="password"
              autoComplete="off"
              placeholder="Paste the provider secret"
              value={secret}
              onChange={(e) => {
                setSecret(e.target.value);
                if (formError) setFormError(null);
              }}
              disabled={creating}
              fieldClassName="flex-1"
            />
            <Field
              label="Label (optional)"
              placeholder="e.g. Production"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
                if (formError) setFormError(null);
              }}
              disabled={creating}
              fieldClassName="flex-1"
            />
          </div>
          {/* A general form error (bad shape, label too long, cap reached, …) — not tied to the Secret field,
              since it may concern the label or the endpoint as a whole. Cleared as soon as the operator edits. */}
          {formError ? <Banner tone="danger">{formError}</Banner> : null}
          <div>
            <Button type="submit" disabled={!canCreate}>
              Add secret
            </Button>
          </div>
        </form>

        {secrets.length === 0 ? (
          <p className="text-sm text-fg-secondary">
            No provider secrets yet. Add one above to start verifying inbound webhooks.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Provider</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Added</TableHead>
                <TableHead className="w-0 text-right">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {secrets.map((item) => {
                const rowBusy = isBusy(`row:${item.id}`);
                const revoked = item.status === "revoked";
                return (
                  <TableRow key={item.id}>
                    <TableCell className="text-fg">{providerDisplayName(item.provider)}</TableCell>
                    <TableCell className="text-fg-secondary">
                      {item.label ?? <span className="text-fg-muted">—</span>}
                    </TableCell>
                    <TableCell>
                      <StatusPill tone={statusTone(item.status)}>{item.status}</StatusPill>
                    </TableCell>
                    <TableCell className="text-fg-secondary">
                      {optimisticIds.has(item.id) ? "Just now" : formatDate(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      {revoked ? (
                        <span className="text-xs text-fg-muted">Revoked</span>
                      ) : (
                        <Button
                          variant="danger"
                          size="sm"
                          onClick={() => requestRemove(item)}
                          disabled={rowBusy}
                        >
                          Revoke
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <RevokeSecretDialog
        item={removing}
        pending={removing ? isBusy(`row:${removing.id}`) : false}
        error={removeError}
        onCancel={closeRemove}
        onConfirm={confirmRemove}
      />
    </Card>
  );
}

// The destructive revoke confirm, split out so the dialog + copy live in one place (mirrors the destinations
// remove confirm). Escape / outside-click can't dismiss mid-flight, and a failure renders INSIDE the dialog.
function RevokeSecretDialog({
  item,
  pending,
  error,
  onCancel,
  onConfirm,
}: {
  item: ProviderSecretItem | null;
  pending: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog
      open={item !== null}
      onOpenChange={(open) => {
        if (open || pending) return;
        onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Revoke this secret?</DialogTitle>
          <DialogDescription>
            Inbound webhooks signed with it stop verifying immediately. This can&apos;t be undone —
            you&apos;d add a fresh secret to verify again.
          </DialogDescription>
        </DialogHeader>
        {error ? <Banner tone="danger">{error}</Banner> : null}
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="secondary" disabled={pending}>
              Cancel
            </Button>
          </DialogClose>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            Revoke secret
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
