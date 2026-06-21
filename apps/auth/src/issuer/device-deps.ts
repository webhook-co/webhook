// A4b — wire the device-code store (A4a) to the real Worker runtime: the DEVICE_KV binding, a unix-second
// clock, and a CSPRNG-backed randomBytes (crypto.getRandomValues — the real entropy A4a's store assumes).
// Shared by both device endpoints: /device_authorization (createDeviceCode) and the /token device grant
// (pollDeviceCode). Pure wiring, no I/O at construction — verified by build:cf/deploy:dry.

import type { DeviceKv, DeviceStoreDeps } from "./device-store";

/** Build the device-store deps from the Worker env's DEVICE_KV binding (a KVNamespace, typed unknown). */
export function makeDeviceStoreDeps(kv: unknown): DeviceStoreDeps {
  return {
    kv: kv as DeviceKv,
    nowSeconds: () => Math.floor(Date.now() / 1000),
    randomBytes: (n) => crypto.getRandomValues(new Uint8Array(n)),
  };
}
