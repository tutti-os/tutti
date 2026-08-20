import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "application/index": "src/application/index.ts",
    "i18n/index": "src/ui/i18n/index.ts",
    "ui/index": "src/ui/index.ts"
  },
  external: [
    "@tutti-os/connector-contracts",
    "@tutti-os/connector-contracts/authorization/v1",
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
