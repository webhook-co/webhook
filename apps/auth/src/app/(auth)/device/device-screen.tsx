import { DeviceActionsClient } from "./device-actions";

/** Next gives `string[]` for a repeated query param (`?user_code=a&user_code=b`); collapse to the first
 *  value so a crafted/duplicated param can't reach `normalizeCode` as an array and crash the render. */
export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * The device page body, inside AuthShell. Two states keyed off the issuer's query params:
 *
 *  - `?status=approved|denied` → a TERMINAL panel. After the user decides on /consent, the consent client
 *    navigates here via window.location.assign, so /device — not /consent — is the screen the user ends
 *    on; it must show the outcome, not the entry form again. Both outcomes are handled (the issuer emits
 *    `denied` too) or a denied flow would show the stale form.
 *  - otherwise → the code-entry form, pre-filled from `?user_code` (verification_uri_complete).
 *
 * `status` WINS over `user_code` (terminal beats form); an unrecognized status falls through to the form.
 * The terminal markup mirrors consent-form.tsx's outcome panel (voice + `role="status"` for a11y).
 */
export function DeviceScreen({ status, userCode }: { status?: string; userCode?: string }) {
  if (status === "approved" || status === "denied") {
    const approved = status === "approved";
    return (
      <div className="flex flex-col gap-4" role="status">
        <div className="flex flex-col gap-1.5">
          <h1 className="text-2xl font-semibold tracking-heading text-fg">
            {approved ? "Device connected" : "Request denied"}
          </h1>
          <p className="leading-snug text-fg-secondary">
            {approved
              ? "Your device is connected. You can close this tab and return to it."
              : "This request was denied. You can close this tab."}
          </p>
        </div>
      </div>
    );
  }

  return <DeviceActionsClient initialCode={userCode} />;
}
