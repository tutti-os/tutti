import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    browser: "src/browser.ts",
    node: "src/node.ts"
  },
  format: ["esm"],
  sourcemap: false,
  tsconfig: "tsconfig.build.json"
});
