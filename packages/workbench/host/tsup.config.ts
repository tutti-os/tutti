import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "conformance/index": "src/conformance/index.ts"
  },
  external: ["@tutti-os/workbench-surface"],
  format: ["esm"],
  sourcemap: true
});
