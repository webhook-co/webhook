"use client";

import { makeDeviceActions } from "@/runtime/consent-client";

import { DeviceForm } from "./device-form";

/**
 * Client wrapper: injects the live device-verify action (POST /device/verify) into Lane E's DeviceForm.
 * On success the server returns the consent screen URL to advance to; the UI is unchanged (E8a).
 */
export function DeviceActionsClient() {
  return <DeviceForm actions={makeDeviceActions()} />;
}
