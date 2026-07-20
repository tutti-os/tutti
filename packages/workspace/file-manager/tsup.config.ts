import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "i18n/index": "src/i18n/index.ts",
    "services/index": "src/services/index.ts"
  },
  external: ["react", "react-dom", "valtio"],
  format: ["esm"],
  loader: {
    ".png": "dataurl"
  },
  sourcemap: true
});
