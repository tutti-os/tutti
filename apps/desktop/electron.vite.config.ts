import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { PerfMonitorVitePlugin } from "@tutti-os/rrt-plugin-vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { PluginOption } from "vite";
import { waitForRendererWarmupPlugin } from "../../tools/scripts/renderer-dev-warmup.mjs";
import { tuttiAssetProtocolAssets } from "./src/main/host/tuttiAssetProtocolAssets.ts";

const aliases = {
  "@app/renderer": resolve("../../packages/agent/gui/app/renderer"),
  "@contexts": resolve("../../packages/agent/gui/contexts"),
  "@main": resolve("src/main"),
  "@tutti-os/workspace-file-manager/assets/workspace-archive-fallback.png":
    resolve(
      "../../packages/workspace/file-manager/src/assets/workspace-archive-fallback.png"
    ),
  "@tutti-os/workspace-file-manager/assets/workspace-folder-fallback.png":
    resolve(
      "../../packages/workspace/file-manager/src/assets/workspace-folder-fallback.png"
    ),
  "@tutti-os/workspace-file-manager/services": resolve(
    "../../packages/workspace/file-manager/src/services/index.ts"
  ),
  "@tutti-os/workspace-file-manager/i18n": resolve(
    "../../packages/workspace/file-manager/src/i18n/index.ts"
  ),
  "@tutti-os/workspace-file-manager": resolve(
    "../../packages/workspace/file-manager/src/index.ts"
  ),
  "@tutti-os/workspace-external-core/contracts": resolve(
    "../../packages/workspace/external-core/src/contracts/index.ts"
  ),
  "@tutti-os/workspace-external-core/core": resolve(
    "../../packages/workspace/external-core/src/core/index.ts"
  ),
  "@tutti-os/workspace-external-core/rich-text": resolve(
    "../../packages/workspace/external-core/src/rich-text/index.ts"
  ),
  "@tutti-os/workspace-external-core": resolve(
    "../../packages/workspace/external-core/src/index.ts"
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

const externalizeRuntimeDeps = externalizeDepsPlugin({
  exclude: [
    "@tutti-os/client-tuttid-ts",
    "@tutti-os/browser-node",
    "@tutti-os/event-protocol",
    "@tutti-os/event-stream-core",
    "@tutti-os/agent-activity-core",
    "@tutti-os/agent-gui",
    "@tutti-os/desktop-update-admission",
    "@tutti-os/ui-i18n-runtime",
    "@tutti-os/ui-system",
    "@tutti-os/workbench-electron",
    "@tutti-os/workspace-file-manager",
    "@tutti-os/workspace-external-core",
    "@tutti-os/workspace-file-preview",
    "@tutti-os/workspace-user-project",
    "ws"
  ]
});

const bundledWsDefines = {
  "process.env.WS_NO_BUFFER_UTIL": '"true"',
  "process.env.WS_NO_UTF_8_VALIDATE": '"true"'
};

// TUTTI_DESKTOP_DEV_PORT pins the renderer dev server to an explicit port so
// a second local checkout (or another electron-vite project) can keep the
// default 5173. strictPort makes a collision fail loudly instead of silently
// hopping to a port the Electron main process did not expect.
const devServerPort = Number.parseInt(
  process.env.TUTTI_DESKTOP_DEV_PORT ?? "",
  10
);
const devServer = {
  host: "127.0.0.1",
  ...(Number.isInteger(devServerPort) && devServerPort > 0
    ? { port: devServerPort, strictPort: true }
    : {}),
  hmr: {
    host: "127.0.0.1"
  }
};

const rendererWarmupEntryUrls = [
  "/src/main.tsx",
  "/src/app/windows/workspace/createWorkspaceWindowContainer.ts",
  "/src/app/windows/workspace/DefaultWorkspaceWindow.tsx",
  "/src/features/workspace-workbench/ui/WorkspaceWorkbench.tsx",
  "/src/app/windows/workspace/StandaloneAgentWorkspaceWindow.tsx"
];

function emitTuttiAssetProtocolAssetsPlugin(): PluginOption {
  return {
    name: "emit-tutti-asset-protocol-assets",
    apply: "build",
    async buildStart(): Promise<void> {
      for (const [route, sourceRelativePath] of Object.entries(
        tuttiAssetProtocolAssets
      )) {
        const source = await readFile(resolve(sourceRelativePath));
        this.emitFile({
          type: "asset",
          fileName: `assets/tutti-asset/${route}`,
          source
        });
      }
    }
  };
}

function envFlagEnabled(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/iu.test(value?.trim() ?? "");
}

const perfMonitorEnabled = envFlagEnabled(
  process.env.TUTTI_ENABLE_PERF_MONITOR
);

function createPerfMonitorPlugin(): PluginOption {
  return PerfMonitorVitePlugin({
    separate: true,
    diffMode: "lite",
    updateTrace: true,
    commitTrace: true
  });
}

const guestPreloadEntryFileNames = new Set([
  "browser-node-guest.cjs",
  "minimum-version.cjs",
  "workspace-app.cjs"
]);

const relativeChunkRequirePattern = /require\(["']\.\/[^"']+["']\)/;

function enforceSelfContainedGuestPreloadsPlugin(): PluginOption {
  return {
    name: "enforce-self-contained-guest-preloads",
    generateBundle(_options, bundle): void {
      for (const item of Object.values(bundle)) {
        if (
          item.type !== "chunk" ||
          !item.isEntry ||
          !guestPreloadEntryFileNames.has(item.fileName)
        ) {
          continue;
        }
        if (relativeChunkRequirePattern.test(item.code)) {
          this.error(
            `${item.fileName} must be self-contained; guest preload entries cannot require Rollup shared chunks.`
          );
        }
      }
    }
  };
}

export default defineConfig({
  main: {
    define: bundledWsDefines,
    plugins: [externalizeRuntimeDeps],
    resolve: {
      alias: aliases
    }
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          "browser-node-guest": resolve(
            "src/preload/entries/browserNodeGuest.ts"
          ),
          capture: resolve("src/preload/entries/capture.ts"),
          index: resolve("src/preload/index.ts"),
          "minimum-version": resolve("src/preload/entries/minimumVersion.ts"),
          "workspace-app": resolve("src/preload/entries/workspaceApp.ts")
        },
        output: {
          chunkFileNames: "[name]-[hash].cjs",
          entryFileNames: "[name].cjs",
          format: "cjs"
        }
      }
    },
    define: bundledWsDefines,
    plugins: [
      externalizeRuntimeDeps,
      enforceSelfContainedGuestPreloadsPlugin()
    ],
    resolve: {
      alias: aliases
    }
  },
  renderer: {
    build: {
      rollupOptions: {
        input: {
          capture: resolve("src/renderer/capture.html"),
          index: resolve("src/renderer/index.html"),
          "minimum-version": resolve("src/renderer/minimum-version.html")
        }
      }
    },
    server: devServer,
    plugins: [
      emitTuttiAssetProtocolAssetsPlugin(),
      waitForRendererWarmupPlugin({
        entryUrls: rendererWarmupEntryUrls
      }),
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
      tailwindcss(),
      ...(perfMonitorEnabled ? [createPerfMonitorPlugin()] : [])
    ],
    resolve: {
      alias: aliases
    }
  }
});
