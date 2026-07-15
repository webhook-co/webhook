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

import { deleteOrganization } from "@/server/org-actions";

/**
 * The settings danger zone: permanently delete the organization. Opens a confirmation modal whose submit
 * stays disabled until "DELETE" is typed; the typed value rides along as `confirm` and the server action
 * re-checks both the acknowledgement and the caller's owner role before doing anything.
 */
export function DeleteOrgCard({ slug }: { slug: string }) {
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
        <ConfirmDialog
          trigger={<Button variant="danger">Delete organization</Button>}
          title="Delete organization"
          description="This permanently deletes the organization and everything in it — endpoints, events, captured payloads, destinations, and settings. It cannot be undone."
          formAction={deleteOrganization.bind(null, slug)}
          confirmText="DELETE"
          confirmLabel="Permanently delete"
        />
      </CardContent>
    </Card>
  );
}
