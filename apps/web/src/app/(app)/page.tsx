import { redirect } from "next/navigation";

// The dashboard home routes to settings (the only v1 surface). The (app) layout gate runs
// first, so an unauthenticated request is redirected to sign-in before this.
export default function AppHome() {
  redirect("/settings");
}
