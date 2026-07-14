"use client";

import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle } from "@webhook-co/ui";
import { useState } from "react";

import { SubmitButton } from "@/components/submit-button";
import { deleteOrganization } from "@/server/org-actions";

/**
 * The settings danger zone: permanently delete the organization. Irreversible, so it's a two-step
 * type-to-confirm — the destructive submit stays disabled until "DELETE" is typed, and the server
 * action re-checks the acknowledgement and the caller's owner role before doing anything.
 */
export function DeleteOrgCard({ slug }: { slug: string }) {
  const [confirming, setConfirming] = useState(false);
  const [text, setText] = useState("");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete organization</CardTitle>
        <CardDescription>
          Permanently delete this organization and everything in it — endpoints, events, captured
          payloads, destinations, and settings. This cannot be undone.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {!confirming ? (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete organization…
          </Button>
        ) : (
          <form action={deleteOrganization.bind(null, slug)} className="flex flex-col gap-3">
            <label htmlFor="confirm-delete" className="text-sm text-fg-secondary">
              Type <span className="font-mono font-semibold text-fg">DELETE</span> to confirm.
            </label>
            <input
              id="confirm-delete"
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
                Permanently delete
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
