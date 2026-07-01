// @webhook-co/openapi — the contract-synced OpenAPI 3.1 spec generator + the declarative route manifest.
//
// The runtime router (apps/api) imports the light `./routes` entry (no generator deps). The generator
// (buildOpenApiDocument) walks the capability contract + the route manifest to emit the spec; the
// committed src/openapi.json is the golden artifact the drift-guard test re-derives and compares.

export * from "./routes";
export { buildOpenApiDocument, type OpenApiDocument } from "./generate";
