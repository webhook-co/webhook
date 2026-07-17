import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import jsxA11y from "eslint-plugin-jsx-a11y";
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
      "**/.open-next/**",
      "**/out/**",
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
      // four STATIC access forms are flagged: member (`env.HYPERDRIVE_CACHED`),
      // computed-literal (`env["HYPERDRIVE_CACHED"]`), and destructuring
      // (`const { HYPERDRIVE_CACHED } = env`, plain / renamed / string-keyed).
      //
      // The destructure selectors are load-bearing, not belt-and-braces: a destructure is
      // an ObjectPattern, NOT a MemberExpression, so the first two miss it entirely —
      // `const { HYPERDRIVE_CACHED } = env; createClient(HYPERDRIVE_CACHED.connectionString)`
      // passed this rule cleanly until a code review probed it. Exercised by
      // scripts/eslint-c1-rule.test.mjs, which is what would have caught that.
      //
      // NOT flagged, and not claimed to be: a VARIABLE-keyed access (`env[k]`), which no
      // syntactic selector can resolve, and a type/interface declaration of the binding
      // (neither node type). This comment used to say "every value access ... and any
      // indirection" is caught; that was false — `env[k]` escapes all four.
      //
      // It then said the dynamic case was "covered by the deploy-time posture check".
      // That was ALSO false: the posture check reads wrangler configs, not source, and it
      // exempted the cached binding by name. Nothing covered it. The real answer is that
      // there is no longer a caching binding to reach: the dead HYPERDRIVE_CACHED binding
      // was deleted, so `env[k]` cannot resolve to a caching pool from app code. If one is
      // ever re-added, this gap is REAL again and this comment must say so.
      // If a read is genuinely non-tenant/cache-safe, opt in explicitly:
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
        {
          // `const { HYPERDRIVE_CACHED } = env` / `const { HYPERDRIVE_CACHED: x } = env`.
          selector: "ObjectPattern > Property[key.name='HYPERDRIVE_CACHED']",
          message:
            "C1 (ADR-0002): the cached Hyperdrive binding must not serve tenant reads — route tenant reads through packages/db on HYPERDRIVE_TENANT. If genuinely cache-safe (non-tenant), disable this line with a `cache-safe (C1): <reason>` justification.",
        },
        {
          // `const { "HYPERDRIVE_CACHED": x } = env` — a string-keyed pattern.
          selector: "ObjectPattern > Property > Literal[value='HYPERDRIVE_CACHED']",
          message:
            "C1 (ADR-0002): the cached Hyperdrive binding must not serve tenant reads — route tenant reads through packages/db on HYPERDRIVE_TENANT. If genuinely cache-safe (non-tenant), disable this line with a `cache-safe (C1): <reason>` justification.",
        },
      ],
    },
  },

  // Build/tooling scripts and config files run in Node and legitimately touch the
  // filesystem with computed paths.
  {
    files: [
      "scripts/**/*.{mjs,js,ts}",
      "apps/*/scripts/**/*.{mjs,js,ts}",
      "apps/*/playwright/**/*.{mjs,js,ts}",
      "packages/*/scripts/**/*.{mjs,js,ts}",
      "**/*.config.{mjs,js,ts}",
      "**/bench/**/*.mjs",
    ],
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

  // Accessibility linting for the marketing site. Scoped to apps/www (the dashboard, apps/web,
  // is a separate follow-up so its findings don't ride along here). The design-ux rule already
  // mandates a11y here; this enforces it at lint time.
  {
    files: ["apps/www/**/*.{jsx,tsx}"],
    ...jsxA11y.flatConfigs.recommended,
    rules: {
      ...jsxA11y.flatConfigs.recommended.rules,
      // The nav/footer/CTA links are intentional `href="#"` placeholders pending real routes.
      // Warn (don't error) so they're visible without blocking CI — the repo lint is bare
      // `eslint .` with no --max-warnings. Flip back to the recommended "error" once routes exist.
      "jsx-a11y/anchor-is-valid": "warn",
    },
  },

  // Prettier must come last so it can disable any conflicting stylistic rules.
  prettier,
);
