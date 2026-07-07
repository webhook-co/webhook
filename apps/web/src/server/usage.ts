import "server-only";

import { withTenant } from "@webhook-co/db/client";
import { readUsageSummary } from "@webhook-co/db/reads";
import type { UsageSummary } from "@webhook-co/shared";

import { logActionError } from "./action-log";
import { withTenantDb } from "./db";

// The usage surface for the dashboard (usage.get). Reads the org's metering usage for the current
// billing period via the shared Lane read under withTenant(orgId) as webhook_app; RLS (the session
// orgId) is the tenant backstop, so the query never filters by org_id itself. Single dimension =
// events; NO prices — the db `UsageSummary` view carries the cap + pause behavior only.

export type UsageResult =
  { readonly status: "ok"; readonly usage: UsageSummary } | { readonly status: "error" };

/** The org's metering usage for the current billing period. Never throws — a db fault becomes the
 *  error state (the page renders a banner) rather than a 500. */
export async function loadUsage(orgId: string): Promise<UsageResult> {
  try {
    const usage = await withTenantDb((app) =>
      withTenant(app, orgId, (tx) => readUsageSummary(tx, Date.now())),
    );
    return { status: "ok", usage };
  } catch (error) {
    logActionError("usage.load_failed", error);
    return { status: "error" };
  }
}
