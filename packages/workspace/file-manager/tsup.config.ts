import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  dts: true,
  entry: {
    index: "src/index.ts",
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
