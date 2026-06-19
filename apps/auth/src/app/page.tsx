import { Wordmark } from "@webhook-co/ui";

// Scaffold holding page for auth.webhook.co. The real surfaces land in Lane E's later slices:
// /login (E3), /consent + /device (E4). Replace this root page when login ships.
export default function AuthHome() {
  return (
    <main className="grid min-h-dvh place-items-center bg-surface-page p-6">
      <div className="flex flex-col items-center gap-3 text-center">
        <Wordmark />
        <p className="text-sm text-fg-secondary">Sign in — coming soon.</p>
      </div>
    </main>
  );
}
