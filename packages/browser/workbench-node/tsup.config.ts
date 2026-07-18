import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "bridge/index": "src/bridge/index.ts",
    "electron-main/index": "src/electron-main/index.ts",
    "electron-preload/index": "src/electron-preload/index.ts",
    "electron-renderer/index": "src/electron-renderer/index.ts",
    "i18n/index": "src/i18n/index.ts",
    "react/index": "src/react/index.ts",
    "workbench/index": "src/workbench/index.ts"
  },
  external: ["electron", "react", "react-dom"],
  format: ["esm"],
  sourcemap: true
});
