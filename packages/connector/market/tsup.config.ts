import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "contracts/index": "src/contracts/index.ts",
    "i18n/index": "src/i18n/index.ts",
    "renderer/index": "src/renderer/index.ts",
    "services/index": "src/services/index.ts"
  },
  external: [
    "@tutti-os/ui-i18n-runtime",
    "@tutti-os/ui-system",
    "@tutti-os/ui-system/components",
    "@tutti-os/ui-system/icons",
    "@tutti-os/ui-system/utils",
    "react",
    "react-dom",
    "valtio",
    "valtio/react",
    "valtio/vanilla"
  ],
  format: ["esm"],
  sourcemap: true
});
