import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts"
  },
  external: ["electron"],
  format: ["esm"],
  removeNodeProtocol: false,
  sourcemap: true
});
