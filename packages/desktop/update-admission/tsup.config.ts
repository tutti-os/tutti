import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "contracts/index": "src/contracts/index.ts",
    "core/index": "src/core/index.ts",
    "development/index": "src/development/index.ts",
    "development/mock-server-cli": "src/development/mockServerCli.ts",
    "electron-main/index": "src/electron-main/index.ts",
    "feature-availability/index": "src/feature-availability/index.ts",
    "i18n/index": "src/i18n/index.ts",
    "mandatory-updater/index": "src/mandatory-updater/index.ts",
    "preload/feature-availability": "src/preload/featureAvailability.ts",
    "preload/index": "src/preload/index.ts",
    "preload/minimum-version": "src/preload/minimumVersion.ts",
    "react/index": "src/react/index.ts"
  },
  external: ["electron", "react", "react-dom"],
  format: ["esm"],
  removeNodeProtocol: false,
  sourcemap: true
});
