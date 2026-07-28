import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    "components/index": "src/components/index.ts",
    "date-format": "src/lib/date-format.ts",
    "dev-vite": "src/dev-vite.ts",
    "icons/index": "src/icons/index.ts",
    index: "src/index.ts",
    "metadata/index": "src/metadata/index.ts",
    native: "src/native/index.ts",
    utils: "src/lib/utils.ts"
  },
  format: ["esm"],
  sourcemap: true
});
