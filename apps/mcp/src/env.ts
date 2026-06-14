// Bindings for the mcp. OAuth issuer+resource Worker (§0.8, WS-D2a). The grant carries the org
// context in its props, so the OAuth/auth layer needs ONLY the provider's KV store — no DB. The
// DB/Hyperdrive bindings arrive with the MCP tool-dispatch binding (a separate workstream), where
// the handler actually queries tenant data under the resolved AuthContext.
export interface McpEnv {
  /** The OAuthProvider's token / grant / client store (required by the library). */
  OAUTH_KV: KVNamespace;
}

/** The execution context the OAuthProvider augments with the validated grant's `props`. */
export type AuthedExecutionContext = ExecutionContext & { props: unknown };
