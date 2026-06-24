import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "contracts/index": "src/contracts/index.ts",
    "core/index": "src/core/index.ts",
    "rich-text/index": "src/rich-text/index.ts"
  },
  format: ["esm"],
  sourcemap: true
});
