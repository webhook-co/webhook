"use client";

import {
  Banner,
  Button,
  Checkbox,
  CopyButton,
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Field,
} from "@webhook-co/ui";
import * as React from "react";

import type { CreateKeyInput, CreateKeyResult, RevokeResult } from "@/server/credential-actions";
import type { ApiKeyItem, CredentialsResult, DeviceGrant } from "@/server/credentials";

import { CredentialsView } from "./credentials-view";

/** What the confirm dialog is currently asking to revoke. */
type RevokeTarget = { kind: "key"; item: ApiKeyItem } | { kind: "grant"; item: DeviceGrant };

export interface CredentialsManagerProps {
  initialResult: CredentialsResult;
  /** The create-key server action, injected by the gated page. */
  createKey: (input: CreateKeyInput) => Promise<CreateKeyResult>;
  /** Revoke a standalone API key, injected by the gated page. */
  revokeKey: (keyId: string) => Promise<RevokeResult>;
  /** Revoke a device grant (cascades to its keys), injected by the gated page. */
  revokeGrant: (grantId: string) => Promise<RevokeResult>;
  /**
   * The grantable scopes for the create-key picker, handed down by the gated server page
   * (`CAPABILITY_SCOPES`). Passed as data so the client bundle never imports the
   * `@webhook-co/contract` registry — the server action remains the scope-narrowing authority.
   */
  scopes: readonly string[];
}

/** The confirm copy for a revoke, derived from the target (null while the dialog closes). */
function revokeCopy(target: RevokeTarget | null): { title: string; body: string; confirm: string } {
  if (target?.kind === "grant") {
    const n = target.item.keys.length;
    const keys = n === 0 ? "" : ` and the ${n} key${n === 1 ? "" : "s"} minted under it`;
    const device = target.item.deviceName ?? "This device";
    return {
      title: "Revoke device?",
      body: `"${device}"${keys} will stop working immediately. This can't be undone.`,
      confirm: "Revoke device",
    };
  }
  return {
    title: "Revoke API key?",
    body: `"${target?.item.name ?? "This key"}" will stop working immediately. This can't be undone.`,
    confirm: "Revoke key",
  };
}

export function CredentialsManager({
  initialResult,
  createKey,
  revokeKey,
  revokeGrant,
  scopes,
}: CredentialsManagerProps) {
  // Mutations only apply to a successful load; error/denied just render the read-only view.
  const [keys, setKeys] = React.useState<readonly ApiKeyItem[]>(
    initialResult.status === "ok" ? initialResult.keys : [],
  );
  const [devices, setDevices] = React.useState<readonly DeviceGrant[]>(
    initialResult.status === "ok" ? initialResult.devices : [],
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // The just-minted secret, held transiently for the one-time reveal — never persisted to `keys`.
  const [revealed, setRevealed] = React.useState<{ name: string; plaintext: string } | null>(null);
  // The credential the confirm dialog is asking to revoke, plus its in-flight/error state.
  const [revoking, setRevoking] = React.useState<RevokeTarget | null>(null);
  const [revokePending, setRevokePending] = React.useState(false);
  const [revokeError, setRevokeError] = React.useState<string | null>(null);

  if (initialResult.status !== "ok") {
    return <CredentialsView result={initialResult} />;
  }

  const canCreate = name.trim() !== "" && selected.size > 0 && !pending;

  function resetForm() {
    setName("");
    setSelected(new Set());
    setFormError(null);
  }

  function toggleScope(scope: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(scope)) next.delete(scope);
      else next.add(scope);
      return next;
    });
  }

  async function handleCreate(event: React.FormEvent) {
    event.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      const chosen = scopes.filter((s) => selected.has(s));
      const result = await createKey({ name: name.trim(), scopes: chosen });
      if (!result.ok) {
        setFormError(result.error);
        return;
      }
      setKeys((prev) => [result.key, ...prev]);
      setCreateOpen(false);
      resetForm();
      setRevealed({ name: result.key.name, plaintext: result.plaintext });
    } catch {
      setFormError("We couldn't create the key. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function requestRevoke(target: RevokeTarget) {
    setRevokeError(null);
    setRevoking(target);
  }

  async function confirmRevoke() {
    if (!revoking) return;
    const target = revoking; // stable snapshot across the await
    setRevokePending(true);
    setRevokeError(null);
    try {
      if (target.kind === "key") {
        const result = await revokeKey(target.item.id);
        if (!result.ok) {
          setRevokeError(result.error);
          return;
        }
        const at = new Date();
        setKeys((prev) => prev.map((k) => (k.id === target.item.id ? { ...k, revokedAt: at } : k)));
      } else {
        const result = await revokeGrant(target.item.id);
        if (!result.ok) {
          setRevokeError(result.error);
          return;
        }
        // Reflect Lane B's cascade: the grant and every key minted under it go dead together.
        const at = new Date();
        setDevices((prev) =>
          prev.map((g) =>
            g.id === target.item.id
              ? {
                  ...g,
                  status: "revoked" as const,
                  revokedAt: at,
                  keys: g.keys.map((k) => (k.revokedAt ? k : { ...k, revokedAt: at })),
                }
              : g,
          ),
        );
      }
      setRevoking(null);
    } catch {
      setRevokeError("We couldn't revoke it. Please try again.");
    } finally {
      setRevokePending(false);
    }
  }

  const revokeMsg = revokeCopy(revoking);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex justify-end">
        <Dialog
          open={createOpen}
          onOpenChange={(open) => {
            setCreateOpen(open);
            if (!open) resetForm();
          }}
        >
          <DialogTrigger asChild>
            <Button>Create key</Button>
          </DialogTrigger>
          <DialogContent>
            <form onSubmit={handleCreate} className="flex flex-col gap-5">
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  You&apos;ll see the secret once, right after it&apos;s created.
                </DialogDescription>
              </DialogHeader>

              <Field
                label="Key name"
                placeholder="e.g. CI deploy"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={pending}
              />

              <fieldset className="flex flex-col gap-2.5">
                <legend className="mb-1.5 text-sm font-medium text-fg">Scopes</legend>
                {scopes.map((scope) => {
                  const id = `scope-${scope}`;
                  return (
                    <label key={scope} htmlFor={id} className="flex items-center gap-2.5">
                      <Checkbox
                        id={id}
                        checked={selected.has(scope)}
                        onCheckedChange={() => toggleScope(scope)}
                        disabled={pending}
                      />
                      <span className="font-mono text-sm text-fg">{scope}</span>
                    </label>
                  );
                })}
              </fieldset>

              {formError ? <Banner tone="danger">{formError}</Banner> : null}

              <DialogFooter>
                <DialogClose asChild>
                  <Button type="button" variant="secondary">
                    Cancel
                  </Button>
                </DialogClose>
                <Button type="submit" disabled={!canCreate}>
                  Create
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <CredentialsView
        result={{ status: "ok", devices, keys }}
        onRevokeKey={(item) => requestRevoke({ kind: "key", item })}
        onRevokeGrant={(item) => requestRevoke({ kind: "grant", item })}
      />

      <Dialog
        open={revoking !== null}
        onOpenChange={(open) => {
          // Don't let Escape / outside-click dismiss mid-flight — otherwise a failure that lands
          // after the close would set an error on an already-closed dialog and be swallowed.
          if (open || revokePending) return;
          setRevoking(null);
          setRevokeError(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{revokeMsg.title}</DialogTitle>
            <DialogDescription>{revokeMsg.body}</DialogDescription>
          </DialogHeader>
          {revokeError ? <Banner tone="danger">{revokeError}</Banner> : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="secondary" disabled={revokePending}>
                Cancel
              </Button>
            </DialogClose>
            <Button variant="danger" onClick={confirmRevoke} disabled={revokePending}>
              {revokeMsg.confirm}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent hideCloseButton>
          <DialogHeader>
            <DialogTitle>Copy your API key</DialogTitle>
            <DialogDescription>
              {revealed ? `The secret for "${revealed.name}".` : null}
            </DialogDescription>
          </DialogHeader>
          <Banner tone="warn">
            This is the only time you&apos;ll see this key — store it somewhere safe.
          </Banner>
          {revealed ? (
            <div className="flex items-center gap-2 rounded-control border border-hairline bg-surface-sunken p-3">
              <code className="min-w-0 flex-1 truncate font-mono text-sm text-fg">
                {revealed.plaintext}
              </code>
              <CopyButton value={revealed.plaintext} size="sm" />
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
