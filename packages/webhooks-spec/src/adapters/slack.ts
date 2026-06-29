// Slack verify adapter — the registry instance produced from SLACK_CONFIG (./config). Headers
// `X-Slack-Signature: v0=<hex>` + `X-Slack-Request-Timestamp`, message `v0:{ts}:{body}`,
// HMAC-SHA256/hex, 5-minute replay window. The recipe lives in the config; this named export is
// kept for the adapter's spec-vector test suite.
// See https://docs.slack.dev/authentication/verifying-requests-from-slack

import { getAdapterForScheme } from "./registry";

export const slackAdapter = getAdapterForScheme("slack")!;
