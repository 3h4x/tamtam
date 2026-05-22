import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import { rules as uiSystemRules } from "./eslint-rules/ui-system.mjs";
import { rules as turbopackNftRules } from "./eslint-rules/turbopack-nft.mjs";

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
      "turbopack-nft": { rules: turbopackNftRules },
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
      // Turbopack/NFT bloat guard — see eslint-rules/turbopack-nft.mjs and
      // the "Turbopack NFT comments" section in CLAUDE.md.
      "turbopack-nft/require-turbopack-ignore-on-dynamic-fs": "error",
    },
  },
  {
    ignores: [".next/", "node_modules/", "skills/", "data/", "app/.well-known/"],
  },
];
