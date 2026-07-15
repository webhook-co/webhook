import { redirect } from "next/navigation";

/**
 * The account area's index. Profile now has its own route (`/account/profile`) so the section can grow more
 * sub-pages; the bare `/account` just lands you on the default one. Kept as a redirect (not deleted) so every
 * existing "Account settings" link keeps working.
 *
 * dal-gate-allow: no data read — an unconditional redirect to the gated profile route, which verifies session.
 */
export default function AccountPage() {
  redirect("/account/profile");
}
