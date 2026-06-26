import { redirect } from "next/navigation";

// The dashboard home routes to endpoints — the entry to the receive → inspect → manage loop. The (app)
// layout gate runs first, so an unauthenticated request is redirected to sign-in before this.
export default function AppHome() {
  redirect("/endpoints");
}
