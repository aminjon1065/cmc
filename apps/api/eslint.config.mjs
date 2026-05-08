import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      // tsc handles most type-safety concerns; the ESLint rules below
      // catch what tsc doesn't.
      //
      // NOTE on `consistent-type-imports`: deliberately NOT enabled.
      // NestJS's DI uses reflect-metadata, which depends on parameter
      // types being emitted as runtime VALUE references. Marking an
      // injected service with `import type` (or even `import { type X }`)
      // strips it from the emitted JS and breaks DI. Until we have a
      // way to mark only non-injected service-imports type-only, we
      // leave imports as plain values.
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "error",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // CLI scripts (seed, migrations, ad-hoc tools) legitimately use
    // `console.log` for human-readable output.
    files: ["src/scripts/**/*.ts"],
    rules: {
      "no-console": "off",
    },
  },
];
