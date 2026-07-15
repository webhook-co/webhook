"use client";

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  ConfirmDialog,
} from "@webhook-co/ui";

import { deleteAccount } from "@/server/account-actions";

/**
 * The settings danger zone: permanently erase your account. Opens a confirmation modal whose submit stays
 * disabled until "DELETE" is typed; the typed value rides along as `confirm` and the server action re-checks
 * it. Deleting your account also deletes your personal organization and everything in it.
 */
export function DeleteAccountCard() {
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
        <ConfirmDialog
          trigger={<Button variant="danger">Delete account</Button>}
          title="Delete account"
          description="This permanently erases your account and your personal organization — your profile, endpoints, events, captured payloads, and settings. It cannot be undone."
          formAction={deleteAccount}
          confirmText="DELETE"
          confirmLabel="Permanently delete my account"
        />
      </CardContent>
    </Card>
  );
}
