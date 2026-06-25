import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts"
  },
  external: ["react", "react-dom"],
  format: ["esm"],
  sourcemap: true
});
