import { AuthShell, ThemeToggle } from "@webhook-co/ui";
import type { Metadata } from "next";

import { DeviceActionsClient } from "./device-actions";

export const metadata: Metadata = {
  title: "Connect a device · webhook.co",
  description: "Enter the code shown on your device to continue.",
};

export default function DevicePage() {
  return (
    <AuthShell homeHref="/" actions={<ThemeToggle />}>
      <DeviceActionsClient />
    </AuthShell>
  );
}
