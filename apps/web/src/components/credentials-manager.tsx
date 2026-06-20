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

import type { CreateKeyInput, CreateKeyResult } from "@/server/credential-actions";
import type { ApiKeyItem, CredentialsResult } from "@/server/credentials";

import { CredentialsView } from "./credentials-view";

export interface CredentialsManagerProps {
  initialResult: CredentialsResult;
  /** The create-key server action, injected by the gated page. */
  createKey: (input: CreateKeyInput) => Promise<CreateKeyResult>;
  /**
   * The grantable scopes for the create-key picker, handed down by the gated server page
   * (`CAPABILITY_SCOPES`). Passed as data so the client bundle never imports the
   * `@webhook-co/contract` registry — the server action remains the scope-narrowing authority.
   */
  scopes: readonly string[];
}

export function CredentialsManager({ initialResult, createKey, scopes }: CredentialsManagerProps) {
  // Mutations only apply to a successful load; error/denied just render the read-only view.
  const [keys, setKeys] = React.useState<readonly ApiKeyItem[]>(
    initialResult.status === "ok" ? initialResult.keys : [],
  );
  const [createOpen, setCreateOpen] = React.useState(false);
  const [name, setName] = React.useState("");
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = React.useState(false);
  const [formError, setFormError] = React.useState<string | null>(null);
  // The just-minted secret, held transiently for the one-time reveal — never persisted to `keys`.
  const [revealed, setRevealed] = React.useState<{ name: string; plaintext: string } | null>(null);

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

      <CredentialsView result={{ status: "ok", devices: initialResult.devices, keys }} />

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
