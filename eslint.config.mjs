import { defineConfig, globalIgnores } from "eslint/config";
import react from "@eslint-react/eslint-plugin";
import next from "@next/eslint-plugin-next";
import tsParser from "@typescript-eslint/parser";
import imports from "eslint-plugin-import-x";
import a11y from "eslint-plugin-jsx-a11y-x";
import hooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default defineConfig([
  {
    name: "chronicle/native-react-next",
    files: ["**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts}"],
    plugins: {
      "@eslint-react": react,
      "@next/next": next,
      "react-hooks": hooks,
      "jsx-a11y-x": a11y,
      "import-x": imports,
    },
    languageOptions: {
      globals: { ...globals.browser, ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: {
      ...next.configs["core-web-vitals"].rules,
      ...hooks.configs.recommended.rules,
      "@eslint-react/no-missing-component-display-name": "error",
      "@eslint-react/no-missing-key": "error",
      "@eslint-react/jsx-no-comment-textnodes": "error",
      "@eslint-react/jsx-no-children-prop": "error",
      "@eslint-react/jsx-no-children-prop-with-children": "error",
      "@eslint-react/dom-no-dangerously-set-innerhtml-with-children": "error",
      "jsx-a11y-x/alt-text": ["warn", { elements: ["img"], img: ["Image"] }],
      "jsx-a11y-x/aria-props": "warn",
      "jsx-a11y-x/aria-proptypes": "warn",
      "jsx-a11y-x/aria-unsupported-elements": "warn",
      "jsx-a11y-x/role-has-required-aria-props": "warn",
      "jsx-a11y-x/role-supports-aria-props": "warn",
      "import-x/no-anonymous-default-export": "warn",
    },
  },
  {
    name: "chronicle/typescript",
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: { parser: tsParser },
  },
  {
    name: "chronicle/typed-jsx",
    files: ["**/*.{js,jsx,mjs,cjs}"],
    rules: {
      // TypeScript owns undefined JSX names, duplicate props and removed API types.
      "no-restricted-syntax": ["error", {
        selector: "JSXElement, JSXFragment",
        message: "Use .tsx for JSX so the project typecheck validates component names and duplicate props.",
      }],
    },
  },
  {
    name: "chronicle/named-component-exports",
    files: ["**/*.tsx"],
    rules: {
      // No TSX classes exist today. Unlike component detection, syntax has no alias loophole.
      "no-restricted-syntax": ["error", {
        selector: "ClassDeclaration, ClassExpression",
        message: "Use function components in .tsx files; keep non-UI classes in .ts.",
      }, {
        selector: "ExportDefaultDeclaration > :matches(TSAsExpression, TSSatisfiesExpression, TSNonNullExpression)",
        message: "Assign asserted default exports to a named binding before exporting them.",
      }],
      // Native display-name checks inspect named memo/forwardRef bindings.
      "import-x/no-anonymous-default-export": ["error", { allowCallExpression: false }],
    },
  },
  globalIgnores([
    "revisions/**",
    ".agents/**",
    ".superpowers/**",
    ".next/**",
    "out/**",
    "output/**",
    "build/**",
    "next-env.d.ts",
    "accessibility-revision/**",
    "backend-revision/**",
  ]),
]);
