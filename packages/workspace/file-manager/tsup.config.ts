import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
    "runtime-assets/workspace-archive-fallback-url":
      "src/runtime-assets/workspace-archive-fallback-url.ts",
    "runtime-assets/workspace-folder-fallback-url":
      "src/runtime-assets/workspace-folder-fallback-url.ts",
    "i18n/index": "src/i18n/index.ts",
    "services/index": "src/services/index.ts"
  },
  external: [
    "@tutti-os/workspace-file-manager/assets/workspace-archive-fallback.png",
    "@tutti-os/workspace-file-manager/assets/workspace-folder-fallback.png",
    "react",
    "react-dom",
    "valtio"
  ],
  format: ["esm"],
  sourcemap: true
});
