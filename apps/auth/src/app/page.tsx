import { redirect } from "next/navigation";

// auth.webhook.co lands on the sign-in surface.
export default function AuthHome() {
  redirect("/login");
}
