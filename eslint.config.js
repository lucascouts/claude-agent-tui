import js from "@eslint/js";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import prettierConfig from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/", "dist/", "coverage/", "*.min.js", "*.config.js", ".github/"],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: "module",
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.json",
      },
      globals: {
        ...globals.node,
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
        },
      ],
      "no-console": "off",
      "no-constant-condition": "off",
      // no-undef is redundant in TS (tsc resolves types/globals) and false-positives on
      // ambient type namespaces like NodeJS.*; disable per typescript-eslint guidance.
      "no-undef": "off",
      "default-case": "error",
      "prefer-const": "error",
      "no-var": "error",
      eqeqeq: ["error", "always"],
      curly: ["error", "all"],
    },
  },
  prettierConfig,
];
