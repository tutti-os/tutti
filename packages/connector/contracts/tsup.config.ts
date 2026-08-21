import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "authorization/v1/index": "src/authorization/v1/index.ts"
  },
  external: ["valibot"],
  format: ["esm"],
  sourcemap: true
});
