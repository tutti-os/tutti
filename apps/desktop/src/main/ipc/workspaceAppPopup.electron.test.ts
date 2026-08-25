import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const resultPrefix = "WORKSPACE_APP_POPUP_INTEGRATION=";

test(
  "real Electron webview uses one canonical producer for each Workspace App popup",
  { timeout: 45_000 },
  async () => {
    const electronPath = createRequire(import.meta.url)("electron") as string;
    const fixturePath = fileURLToPath(
      new URL("./workspaceAppPopup.electron.fixture.ts", import.meta.url)
    );
    const preloadEntryPath = fileURLToPath(
      new URL("../../preload/entries/workspaceApp.ts", import.meta.url)
    );
    const rendererEntryPath = fileURLToPath(
      new URL(
        "../../../test/fixtures/workspaceAppPopupRenderer.electron.fixture.tsx",
        import.meta.url
      )
    );
    const userDataPath = await mkdtemp(
      join(tmpdir(), "tutti-workspace-app-popup-electron-")
    );
    const preloadOutputDirectory = join(userDataPath, "preload");
    const preloadPath = join(preloadOutputDirectory, "workspace-app-popup.cjs");
    const rendererPath = join(
      preloadOutputDirectory,
      "workspace-app-popup-renderer.cjs"
    );

    try {
      await buildWorkspaceAppPreload({
        entryPath: preloadEntryPath,
        outputDirectory: preloadOutputDirectory
      });
      await buildWorkspaceAppPopupRenderer({
        entryPath: rendererEntryPath,
        outputDirectory: preloadOutputDirectory
      });
      const result = await runElectronFixture({
        electronPath,
        fixturePath,
        preloadPath,
        rendererPath,
        userDataPath
      });
      assert.equal(
        result.exitCode,
        0,
        `Electron popup fixture failed:\n${result.stderr}\n${result.stdout}`
      );
      const resultLine = result.stdout
        .split(/\r?\n/u)
        .find((line) => line.startsWith(resultPrefix));
      assert.ok(
        resultLine,
        `missing Electron fixture result:\n${result.stdout}`
      );
      const payload = JSON.parse(resultLine.slice(resultPrefix.length));
      const guestUrl = `${payload.origins.workspaceApp}/guest`;

      assert.deepEqual(payload.cases, [
        {
          browserEvents: 0,
          browserSurfaces: 0,
          deferredPopupRejections: 0,
          guestUrl: `${payload.origins.workspaceApp}/internal?kind=blank-link`,
          kind: "internal-blank-link",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 1,
          rejectionNotifications: 0,
          scriptResult: true,
          workbenchLaunches: 0
        },
        {
          browserEvents: 0,
          browserSurfaces: 0,
          deferredPopupRejections: 0,
          guestUrl: `${payload.origins.workspaceApp}/internal?kind=window-open`,
          kind: "internal-window-open",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 1,
          rejectionNotifications: 0,
          scriptResult: true,
          workbenchLaunches: 0
        },
        {
          browserEvents: 1,
          browserSurfaces: 1,
          deferredPopupRejections: 0,
          guestUrl,
          kind: "blank-link",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 1,
          rejectionNotifications: 0,
          scriptResult: true,
          workbenchLaunches: 1
        },
        {
          browserEvents: 1,
          browserSurfaces: 1,
          deferredPopupRejections: 0,
          guestUrl,
          kind: "window-open",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 1,
          rejectionNotifications: 0,
          scriptResult: true,
          workbenchLaunches: 1
        },
        {
          browserEvents: 1,
          browserSurfaces: 1,
          deferredPopupRejections: 0,
          guestUrl,
          kind: "get-form",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 1,
          rejectionNotifications: 0,
          scriptResult: true,
          workbenchLaunches: 1
        },
        {
          browserEvents: 2,
          browserSurfaces: 2,
          deferredPopupRejections: 0,
          guestUrl,
          kind: "double-window-open",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 2,
          rejectionNotifications: 0,
          scriptResult: true,
          workbenchLaunches: 2
        },
        {
          browserEvents: 0,
          browserSurfaces: 0,
          deferredPopupRejections: 1,
          guestUrl,
          kind: "deferred-window-open",
          nativeChildWindows: 0,
          postPopupRejections: 0,
          producerCallbacks: 1,
          rejectionNotifications: 1,
          scriptResult: true,
          workbenchLaunches: 0
        },
        {
          browserEvents: 0,
          browserSurfaces: 0,
          deferredPopupRejections: 0,
          guestUrl,
          kind: "post-form",
          nativeChildWindows: 0,
          postPopupRejections: 1,
          producerCallbacks: 1,
          rejectionNotifications: 1,
          scriptResult: true,
          workbenchLaunches: 0
        }
      ]);
      assert.deepEqual(payload.counts, {
        browserEvents: 5,
        browserSurfaces: 5,
        deferredPopupRejections: 1,
        nativeChildWindows: 0,
        postPopupRejections: 1,
        producerCallbacks: 9,
        rejectionNotifications: 2,
        workbenchLaunches: 5
      });
      assert.notEqual(payload.origins.popup, payload.origins.workspaceApp);
      assert.equal(payload.events.length, 5);
      for (const event of payload.events) {
        assert.equal(event.type, "open-url");
        assert.equal(event.reuseIfOpen, false);
        assert.match(event.sourceNodeId, /^workspace-app:\d+$/u);
        assert.equal(new URL(event.url).origin, payload.origins.popup);
        assert.equal("operationId" in event, false);
      }
    } finally {
      await rm(userDataPath, { force: true, recursive: true });
    }
  }
);

function runElectronFixture(input: {
  electronPath: string;
  fixturePath: string;
  preloadPath: string;
  rendererPath: string;
  userDataPath: string;
}): Promise<{ exitCode: number | null; stderr: string; stdout: string }> {
  const electronArgs = [
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${input.userDataPath}`,
    input.fixturePath
  ];
  const command =
    process.platform === "linux" ? "xvfb-run" : input.electronPath;
  const args =
    process.platform === "linux"
      ? ["-a", input.electronPath, ...electronArgs]
      : electronArgs;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
        TUTTI_WORKSPACE_APP_POPUP_PRELOAD_PATH: input.preloadPath,
        TUTTI_WORKSPACE_APP_POPUP_RENDERER_PATH: input.rendererPath
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let stdout = "";
    child.stderr.setEncoding("utf8");
    child.stdout.setEncoding("utf8");
    const timeout = setTimeout(() => {
      child.kill();
      reject(
        new Error(`Electron popup fixture timed out:\n${stderr}\n${stdout}`)
      );
    }, 30_000);
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      resolve({ exitCode, stderr, stdout });
    });
  });
}

async function buildWorkspaceAppPreload(input: {
  entryPath: string;
  outputDirectory: string;
}): Promise<void> {
  await viteBuild({
    build: {
      emptyOutDir: true,
      minify: false,
      outDir: input.outputDirectory,
      rollupOptions: {
        external: ["electron"],
        input: input.entryPath,
        output: {
          entryFileNames: "workspace-app-popup.cjs",
          format: "cjs",
          inlineDynamicImports: true
        }
      },
      sourcemap: false,
      target: "node22"
    },
    configFile: false,
    logLevel: "silent"
  });
}

async function buildWorkspaceAppPopupRenderer(input: {
  entryPath: string;
  outputDirectory: string;
}): Promise<void> {
  await viteBuild({
    build: {
      emptyOutDir: false,
      minify: false,
      outDir: input.outputDirectory,
      rollupOptions: {
        external: ["electron"],
        input: input.entryPath,
        output: {
          entryFileNames: "workspace-app-popup-renderer.cjs",
          format: "cjs",
          inlineDynamicImports: true
        }
      },
      sourcemap: false,
      target: "chrome134"
    },
    configFile: false,
    define: {
      "process.env.NODE_ENV": JSON.stringify("test")
    },
    logLevel: "silent"
  });
}
