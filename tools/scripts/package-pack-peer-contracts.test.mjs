import assert from "node:assert/strict";
import test from "node:test";

import {
  externalBundledTiptapImports,
  packagePeerContractViolations
} from "./package-pack-peer-contracts.mjs";

test("accepts matching Tiptap peer and development dependencies", () => {
  assert.deepEqual(
    packagePeerContractViolations("@tutti-os/ui-rich-text", {
      devDependencies: {
        "@tiptap/core": "^3.23.6",
        "@tiptap/extension-document": "^3.23.6",
        "@tiptap/extension-hard-break": "^3.23.6",
        "@tiptap/extension-paragraph": "^3.23.6",
        "@tiptap/extension-text": "^3.23.6"
      },
      peerDependencies: { "@tiptap/core": "^3.23.6" }
    }),
    ["@tiptap/react is missing from peerDependencies"]
  );
  assert.deepEqual(
    packagePeerContractViolations("@tutti-os/ui-rich-text", {
      devDependencies: {
        "@tiptap/core": "^3.23.6",
        "@tiptap/extension-document": "^3.23.6",
        "@tiptap/extension-hard-break": "^3.23.6",
        "@tiptap/extension-paragraph": "^3.23.6",
        "@tiptap/extension-text": "^3.23.6",
        "@tiptap/react": "^3.23.6"
      },
      peerDependencies: {
        "@tiptap/core": "^3.23.6",
        "@tiptap/react": "^3.23.6"
      }
    }),
    []
  );
});

test("rejects package-private or mismatched Tiptap dependencies", () => {
  assert.deepEqual(
    packagePeerContractViolations("@tutti-os/ui-rich-text", {
      devDependencies: {
        "@tiptap/core": "^3.23.6",
        "@tiptap/extension-document": "^3.23.6",
        "@tiptap/extension-hard-break": "^3.23.6",
        "@tiptap/extension-paragraph": "^3.23.6",
        "@tiptap/extension-text": "^3.23.6",
        "@tiptap/react": "^3.23.6"
      },
      peerDependencies: { "@tiptap/react": "^3.23.6" }
    }),
    ["@tiptap/core is missing from peerDependencies"]
  );
  assert.deepEqual(
    packagePeerContractViolations("@tutti-os/ui-rich-text", {
      dependencies: { "@tiptap/extension-document": "^3.23.6" },
      devDependencies: {
        "@tiptap/core": "^3.23.6",
        "@tiptap/extension-hard-break": "^3.23.6",
        "@tiptap/extension-paragraph": "^3.23.6",
        "@tiptap/extension-text": "^3.23.6",
        "@tiptap/react": "^3.23.6"
      },
      peerDependencies: {
        "@tiptap/core": "^3.23.6",
        "@tiptap/react": "^3.23.6"
      }
    }),
    [
      "@tiptap/extension-document must be bundled from devDependencies",
      "@tiptap/extension-document is missing from devDependencies"
    ]
  );
  assert.deepEqual(
    packagePeerContractViolations("@tutti-os/agent-gui", {
      dependencies: { "@tiptap/core": "^3.11.1" },
      devDependencies: { "@tiptap/core": "^3.23.6" }
    }),
    [
      "@tiptap/core must be a peer dependency",
      "@tiptap/core is missing from peerDependencies",
      "@tiptap/pm is missing from peerDependencies",
      "@tiptap/react is missing from peerDependencies",
      "@tiptap/starter-kit is missing from peerDependencies",
      "@tiptap/suggestion is missing from peerDependencies"
    ]
  );
  assert.deepEqual(
    packagePeerContractViolations("@tutti-os/agent-gui", {
      devDependencies: { "@tiptap/core": "^3.11.1" },
      peerDependencies: { "@tiptap/core": "^3.23.6" }
    }),
    [
      "@tiptap/core must use the same peer and dev range",
      "@tiptap/pm is missing from peerDependencies",
      "@tiptap/react is missing from peerDependencies",
      "@tiptap/starter-kit is missing from peerDependencies",
      "@tiptap/suggestion is missing from peerDependencies"
    ]
  );
});

test("finds component-internal Tiptap extensions left external", () => {
  assert.deepEqual(
    externalBundledTiptapImports(
      "@tutti-os/ui-rich-text",
      'import Document from "@tiptap/extension-document";'
    ),
    ["@tiptap/extension-document"]
  );
  assert.deepEqual(
    externalBundledTiptapImports(
      "@tutti-os/ui-rich-text",
      'import { Extension } from "@tiptap/core";'
    ),
    []
  );
});
