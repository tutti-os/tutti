import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const typeScriptFiles = ["**/*.{ts,tsx,mts,cts}"];
const testTypeScriptFiles = ["**/*.{test,spec}.{ts,tsx,mts,cts}"];
const carriedAgentRendererFiles = ["packages/agent/gui/**/*.{ts,tsx}"];

const browserFiles = [
  "apps/desktop/src/renderer/**/*.{ts,tsx}",
  "packages/ui/**/*.{ts,tsx}",
  "packages/workbench/surface/src/react/**/*.{ts,tsx}"
];

const nodeFiles = [
  "apps/**/*.{ts,tsx,mts,cts,mjs,cjs}",
  "packages/**/*.{ts,tsx,mts,cts,mjs,cjs}",
  "tools/**/*.mjs",
  "services/**/*.mjs"
];

const businessTypeScriptFiles = [
  "apps/desktop/src/main/**/*.{ts,tsx}",
  "apps/desktop/src/preload/**/*.{ts,tsx}",
  "packages/clients/**/*.{ts,tsx}"
];

export default defineConfig(
  {
    ignores: [
      "**/.git/**",
      "**/.claude/**",
      "**/.codex/**",
      "**/.tutti-ui-system-dev/**",
      "**/.turbo/**",
      "**/dist/**",
      "**/generated/**",
      "**/node_modules/**",
      "**/out/**",
      "services/tuttid/builtin-apps/**",
      "**/src/internal/ported-source/**",
      "**/tsup.config.ts"
    ]
  },
  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,
  {
    files: ["**/*.{js,jsx,mjs,cjs}"],
    ...tseslint.configs.disableTypeChecked
  },
  {
    files: typeScriptFiles,
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: process.cwd()
      }
    }
  },
  {
    files: nodeFiles,
    languageOptions: {
      ecmaVersion: "latest",
      globals: globals.node,
      sourceType: "module"
    }
  },
  {
    files: browserFiles,
    languageOptions: {
      globals: globals.browser
    }
  },
  {
    files: typeScriptFiles,
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        {
          fixStyle: "separate-type-imports",
          prefer: "type-imports"
        }
      ],
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          varsIgnorePattern: "^_"
        }
      ]
    }
  },
  {
    files: testTypeScriptFiles,
    rules: {
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/require-await": "off"
    }
  },
  {
    files: carriedAgentRendererFiles,
    rules: {
      "no-useless-assignment": "off",
      "prefer-const": "off",
      "@typescript-eslint/consistent-type-imports": "off",
      "@typescript-eslint/no-base-to-string": "off",
      "@typescript-eslint/no-empty-object-type": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-floating-promises": "off",
      "@typescript-eslint/no-misused-promises": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-unnecessary-type-assertion": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/only-throw-error": "off",
      "@typescript-eslint/prefer-promise-reject-errors": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/restrict-template-expressions": "off",
      "@typescript-eslint/unbound-method": "off"
    }
  },
  {
    files: businessTypeScriptFiles,
    ignores: ["**/*.d.ts", "**/*.test.*", "**/generated/**"],
    rules: {
      "max-lines": [
        "error",
        {
          max: 800,
          skipBlankLines: true,
          skipComments: true
        }
      ]
    }
  }
);
