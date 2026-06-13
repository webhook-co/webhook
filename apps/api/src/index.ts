import { SERVICE_NAME } from "@webhook-co/shared";

// Placeholder API entrypoint. The REST API surface lands here.
export const apiService = `${SERVICE_NAME}:api` as const;

// The auth surface: every API handler resolves an AuthContext + enforces the
// capability's scope through this seam (verifyBearer is injected; the impl lives in
// @webhook-co/db). Re-exported so handlers import it from the app root.
export { authorize, extractBearer, type ApiAuthDeps, type AuthzResult } from "./auth";
