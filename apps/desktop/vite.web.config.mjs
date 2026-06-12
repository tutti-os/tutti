import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const rendererRoot = resolve("src/renderer");
const aliases = {
  "@app/renderer": resolve("../../packages/agent/gui/app/renderer"),
  "@contexts": resolve("../../packages/agent/gui/contexts"),
  "@main": resolve("src/main"),
  "@tutti-os/workspace-file-manager/services": resolve(
    "../../packages/workspace/file-manager/src/services/index.ts"
  ),
  "@tutti-os/workspace-file-manager/i18n": resolve(
    "../../packages/workspace/file-manager/src/i18n/index.ts"
  ),
  "@tutti-os/workspace-file-manager": resolve(
    "../../packages/workspace/file-manager/src/index.ts"
  ),
  "@preload": resolve("src/preload"),
  "@renderer": resolve("src/renderer/src"),
  "@shared/contracts/dto": resolve(
    "../../packages/agent/gui/shared/contracts/dto"
  ),
  "@shared/errors/appError": resolve(
    "../../packages/agent/gui/shared/errors/appError.ts"
  ),
  "@shared/featureFlags": resolve(
    "../../packages/agent/gui/shared/featureFlags"
  ),
  "@shared/types": resolve("../../packages/agent/gui/shared/types"),
  "@shared/utils": resolve("../../packages/agent/gui/shared/utils"),
  "@shared": resolve("src/shared")
};

const devServer = {
  host: "127.0.0.1",
  hmr: {
    host: "127.0.0.1"
  }
};

export default defineConfig({
  root: rendererRoot,
  server: devServer,
  plugins: [
    react({
      babel: {
        plugins: [
          [
            "babel-plugin-react-compiler",
            {
              compilationMode: "infer",
              panicThreshold: "none"
            }
          ]
        ]
      }
    }),
    tailwindcss()
  ],
  resolve: {
    alias: aliases
  }
});
