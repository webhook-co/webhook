import { redirect } from "next/navigation";

// The app home routes to the overview dashboard — where a user lands after login and gets a read on inbound
// capture + outbound delivery before diving into a section. The (app) layout gate runs first, so an
// unauthenticated request is redirected to sign-in before this.
export default function AppHome() {
  redirect("/dashboard");
}
