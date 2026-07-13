import { redirect } from "next/navigation";

// dal-gate-allow: owns no tenant data — an unconditional redirect to /credentials, which gates for itself.

// API keys & devices moved to the top-level /credentials section (above Settings). This stub keeps old
// bookmarks and links from 404ing — a permanent client redirect to the new home.
export default function MovedCredentials() {
  redirect("/credentials");
}
