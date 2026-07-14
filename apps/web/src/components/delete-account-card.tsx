"use client";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webhook-co/ui";
import { useState } from "react";

import { SubmitButton } from "@/components/submit-button";
import { deleteAccount } from "@/server/account-actions";

/**
 * The settings danger zone: permanently erase your account. Two-step type-to-confirm (the submit is
 * disabled until "DELETE" is typed; the server action re-checks the acknowledgement). Deleting your
 * account also deletes your personal organization and everything in it.
 */
export function DeleteAccountCard() {
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Permanently erase your account and your personal organization — your profile, endpoints,
          events, captured payloads, and settings. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!confirming ? (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete account…
          </Button>
        ) : (
          <form action={deleteAccount} className="flex flex-col gap-3">
            <label htmlFor="confirm-delete-account" className="text-sm text-fg-secondary">
              Type <span className="font-mono font-semibold text-fg">DELETE</span> to confirm.
            </label>
            <input
              id="confirm-delete-account"
              name="confirm"
              value={text}
              onChange={(e) => setText(e.target.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="w-full max-w-[240px] rounded-control border border-hairline bg-surface px-3 py-2 font-mono text-sm text-fg outline-none focus-visible:shadow-[var(--wh-focus-ring)]"
            />
            <div className="flex gap-2">
              <SubmitButton variant="danger" disabled={text !== "DELETE"}>
                Permanently delete my account
              </SubmitButton>
              <Button
                type="button"
                variant="secondary"
                onClick={() => {
                  setConfirming(false);
                  setText("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
