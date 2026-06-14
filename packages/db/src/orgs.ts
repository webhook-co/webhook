// Org creation (the tenant root). createOrg mints the org id at the edge and inserts the
// row under the NEW org's own RLS context -- the orgs insert policy gates on
// `id = current_org_id()`, so app.current_org must be set to the new id for the insert to
// pass. withTenant sets it. Runs as webhook_app.

import { randomUUID } from "node:crypto";

import { withTenant, type Sql } from "./client";

export interface CreateOrgInput {
  /** URL-safe unique handle (citext unique in the schema). */
  readonly slug: string;
  readonly name: string;
  /** Residency-routing anchor; defaults to the orgs table default ('us'). */
  readonly region?: string;
}

export interface CreatedOrg {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly region: string;
}

/**
 * Create a tenant org. The id is edge-generated (randomUUID() is the stand-in until the
 * shared uuidv7 mint is adopted on the control-plane tables, like createApiKey; orgs are
 * low-volume so v4-vs-v7 index locality is immaterial here). The row is inserted under the
 * new org's RLS context (the orgs insert policy gates on id = current_org_id()).
 */
export async function createOrg(app: Sql, input: CreateOrgInput): Promise<CreatedOrg> {
  const id = randomUUID();
  const region = input.region ?? "us";
  await withTenant(app, id, async (tx) => {
    await tx`
      insert into orgs (id, slug, name, region)
      values (${id}, ${input.slug}, ${input.name}, ${region})`;
  });
  return { id, slug: input.slug, name: input.name, region };
}
