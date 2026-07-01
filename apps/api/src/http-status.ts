// The capability-error → HTTP status map is single-sourced in @webhook-co/openapi/routes so the runtime
// router and the OpenAPI generator map the closed taxonomy to a status identically (the spec can't claim a
// status the server doesn't emit). Re-exported here so existing api-internal imports are unchanged.
export { CAPABILITY_ERROR_STATUS, httpStatusForCapabilityError } from "@webhook-co/openapi/routes";
