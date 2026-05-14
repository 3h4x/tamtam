import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { rules as uiSystemRules } from "./eslint-rules/ui-system.mjs";

export default [
  js.configs.recommended,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "ui-system": { rules: uiSystemRules },
    },
    rules: {
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "off",
      "no-undef": "off",
      "no-empty": "off",
      "no-useless-assignment": "off",
      // UI design system enforcement (docs/UI.md)
      "ui-system/no-icon-library": "error",
      "ui-system/no-hardcoded-color-style": "warn",
      "ui-system/no-font-family-override": "warn",
    },
  },
  {
    ignores: [".next/", "node_modules/", "skills/", "data/", "app/.well-known/"],
  },
];
