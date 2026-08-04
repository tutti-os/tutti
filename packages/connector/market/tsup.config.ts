import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "contracts/index": "src/contracts/index.ts",
    "react/index": "src/react/index.ts",
    "services/index": "src/services/index.ts"
  },
  external: ["react", "valtio", "valtio/react", "valtio/vanilla"],
  format: ["esm"],
  sourcemap: true
});
