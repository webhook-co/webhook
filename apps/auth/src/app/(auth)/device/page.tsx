import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { DeviceScreen, firstParam } from "./device-screen";

export const metadata: Metadata = {
  title: "Connect a device · webhook.co",
  description: "Enter the code shown on your device to continue.",
};

// Reads the issuer's per-request query (`?user_code` pre-fill / `?status` terminal), so it can't be
// statically rendered.
export const dynamic = "force-dynamic";

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ user_code?: string | string[]; status?: string | string[] }>;
}) {
  const { user_code, status } = await searchParams;
  return (
    <AuthShell homeHref="/" actions={<ThemeToggle />}>
      <DeviceScreen status={firstParam(status)} userCode={firstParam(user_code)} />
    </AuthShell>
  );
}
