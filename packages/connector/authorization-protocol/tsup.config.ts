import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "v1/index": "src/v1/index.ts"
  },
  external: ["valibot"],
  format: ["esm"],
  sourcemap: true
});
