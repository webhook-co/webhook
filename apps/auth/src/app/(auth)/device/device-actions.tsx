"use client";

import { makeDeviceActions } from "@/runtime/consent-client";

import { DeviceForm } from "./device-form";

/**
 * Client wrapper: injects the live device-verify action (POST /device/verify) into Lane E's DeviceForm.
 * On success the server returns the consent screen URL to advance to; the UI is unchanged (E8a).
 * `initialCode` pre-fills the field from the page's `?user_code` (verification_uri_complete).
 */
export function DeviceActionsClient({ initialCode }: { initialCode?: string }) {
  return <DeviceForm actions={makeDeviceActions()} initialCode={initialCode} />;
}
