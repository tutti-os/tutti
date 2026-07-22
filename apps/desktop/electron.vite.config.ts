import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { PerfMonitorVitePlugin } from "@tutti-os/rrt-plugin-vite";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import type { PluginOption } from "vite";

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
  "@tutti-os/workspace-external-core/contracts": resolve(
    "../../packages/workspace/external-core/src/contracts/index.ts"
  ),
  "@tutti-os/workspace-external-core/core": resolve(
    "../../packages/workspace/external-core/src/core/index.ts"
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
    "@tutti-os/ui-i18n-runtime",
    "@tutti-os/ui-system",
    "@tutti-os/workspace-file-manager",
    "@tutti-os/workspace-external-core",
    "@tutti-os/workspace-file-preview",
    "ws"
  ]
});

const bundledWsDefines = {
  "process.env.WS_NO_BUFFER_UTIL": '"true"',
  "process.env.WS_NO_UTF_8_VALIDATE": '"true"'
};

const devServer = {
  host: "127.0.0.1",
  hmr: {
    host: "127.0.0.1"
  }
};

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
          index: resolve("src/preload/index.ts"),
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
      tailwindcss(),
      ...(perfMonitorEnabled ? [createPerfMonitorPlugin()] : [])
    ],
    resolve: {
      alias: aliases
    }
  }
});
