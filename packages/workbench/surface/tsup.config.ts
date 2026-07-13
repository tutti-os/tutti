import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "dock-catalog/index": "src/dock-catalog/index.ts",
    index: "src/index.ts",
    "i18n/index": "src/i18n/index.ts"
  },
  format: ["esm"],
  sourcemap: true
});
