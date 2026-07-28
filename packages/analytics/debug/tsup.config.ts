import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "react/index": "src/react/index.ts"
  },
  external: ["react", "react-dom"],
  format: ["esm"],
  sourcemap: true
});
