import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import security from "eslint-plugin-security";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    // Generated/output and vendored paths are never linted.
    ignores: [
      "**/dist/**",
      "**/build/**",
      "**/.turbo/**",
      "**/.wrangler/**",
      "**/.next/**",
      "**/coverage/**",
      "**/node_modules/**",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Security linting: a core guardrail for compliance-by-design work.
  security.configs.recommended,

  {
    rules: {
      // `detect-object-injection` is extremely noisy (flags ordinary bracket access)
      // and produces near-zero real findings; the broader plugin stays on.
      "security/detect-object-injection": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // C1 (ADR-0002): the cached Hyperdrive binding must NEVER serve tenant-scoped
      // reads — its query cache is keyed on SQL+params and is blind to the RLS session
      // GUC, so a cached tenant query could serve one org's rows to another. Every
      // *value* access to the binding is flagged (this catches both
      // `createClient(env.HYPERDRIVE_CACHED.connectionString)` and any indirection);
      // an interface/type declaration of the binding is not a MemberExpression, so it
      // isn't matched. If a read is genuinely non-tenant/cache-safe, opt in explicitly:
      //   // eslint-disable-next-line no-restricted-syntax -- cache-safe (C1): <reason>
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[property.name='HYPERDRIVE_CACHED']",
          message:
            "C1 (ADR-0002): the cached Hyperdrive binding must not serve tenant reads — route tenant reads through packages/db on HYPERDRIVE_TENANT. If genuinely cache-safe (non-tenant), disable this line with a `cache-safe (C1): <reason>` justification.",
        },
        {
          selector: "MemberExpression[computed=true] > Literal[value='HYPERDRIVE_CACHED']",
          message:
            "C1 (ADR-0002): the cached Hyperdrive binding must not serve tenant reads — route tenant reads through packages/db on HYPERDRIVE_TENANT. If genuinely cache-safe (non-tenant), disable this line with a `cache-safe (C1): <reason>` justification.",
        },
      ],
    },
  },

  // Build/tooling scripts and config files run in Node and legitimately touch the
  // filesystem with computed paths.
  {
    files: ["scripts/**/*.{mjs,js,ts}", "**/*.config.{mjs,js,ts}", "**/bench/**/*.mjs"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },

  // Cursor hook scripts are Node tooling: they read the hook payload from stdin and persist a
  // session-scoped dedupe file by computed path. Same exemption as the build scripts above.
  {
    files: [".cursor/hooks/**/*.{mjs,js}"],
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      "security/detect-non-literal-fs-filename": "off",
    },
  },

  // Prettier must come last so it can disable any conflicting stylistic rules.
  prettier,
);
