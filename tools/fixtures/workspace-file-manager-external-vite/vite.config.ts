import { fileURLToPath } from "node:url";

import { defineConfig } from "vite";

const packageRoot = new URL(
  "../../../packages/workspace/file-manager/dist/",
  import.meta.url
);

export default defineConfig({
  optimizeDeps: {
    include: ["@tutti-os/workspace-file-manager"]
  },
  resolve: {
    alias: [
      {
        find: /^@tutti-os\/workspace-file-manager$/u,
        replacement: fileURLToPath(new URL("index.js", packageRoot))
      },
      ...["archive", "folder"].map((fallbackKind) => ({
        find: new RegExp(
          `^@tutti-os/workspace-file-manager/assets/workspace-${fallbackKind}-fallback\\.png$`,
          "u"
        ),
        replacement: fileURLToPath(
          new URL(`assets/workspace-${fallbackKind}-fallback.png`, packageRoot)
        )
      }))
    ]
  }
});
