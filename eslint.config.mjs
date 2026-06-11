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
    },
  },

  // Build/tooling scripts and config files run in Node and legitimately touch the
  // filesystem with computed paths.
  {
    files: ["scripts/**/*.{mjs,js,ts}", "**/*.config.{mjs,js,ts}"],
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
