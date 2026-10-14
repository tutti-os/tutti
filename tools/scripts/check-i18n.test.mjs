import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "check-i18n.mjs"
);

test("passes aligned locale resources and valid i18n usage", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    rendererFiles: {
      "app/App.tsx": `
        export function App() {
          const { t } = useTranslation();
          return <button aria-label={t("common.submitButton")}>{t("common.submitButton")}</button>;
        }
      `
    },
    packageFiles: {
      "packages/workspace/file-manager/src/ui/FileManager.tsx": `
        export function FileManager({ copy }) {
          return <button>{copy.t("uploadLabel")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /i18n check passed/);
});

test("rejects locale keys missing from a non-default locale", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    zhCN: `
      export const zhCN = {
        common: {
          hello: "你好"
        }
      } as const;
    `
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locale-key-missing/);
  assert.match(result.stderr, /common.submitButton/);
});

test("rejects placeholder mismatches across locales", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    zhCN: `
      export const zhCN = {
        common: {
          hello: "你好",
          submitButton: "提交",
          readyStatus: "已就绪"
        }
      } as const;
    `
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locale-placeholder/);
  assert.match(result.stderr, /common.readyStatus/);
});

test("rejects hardcoded JSX copy in renderer source", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    rendererFiles: {
      "app/App.tsx": `
        export function App() {
          return <button>Save workspace</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /hardcoded-jsx-text/);
  assert.match(result.stderr, /Save workspace/);
});

test("rejects missing literal i18n key references", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    rendererFiles: {
      "app/App.tsx": `
        export function App() {
          const { t } = useTranslation();
          return <button>{t("common.missingButton")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /i18n-key-missing/);
  assert.match(result.stderr, /common.missingButton/);
});

test("accepts valid copy.t keys from shared package resources", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    packageFiles: {
      "packages/workspace/file-manager/src/ui/FileManager.tsx": `
        export function FileManager({ copy }) {
          return <button>{copy.t("uploadLabel")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /i18n check passed/);
});

test("accepts scoped keys from multiple i18n modules in the same source root", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    packageFiles: {
      "packages/workbench/surface/src/host/WorkbenchHost.tsx": `
        export function WorkbenchHost({ copy }) {
          return <button aria-label={copy.t("actions.close")}>{copy.t("dockLabel")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /i18n check passed/);
});

test("accepts product-neutral package i18n manifest names", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    packageFiles: {
      "packages/browser/workbench-node/src/i18n/browserNodeI18n.ts":
        defaultBrowserNodeI18n(),
      "packages/browser/workbench-node/src/react/BrowserNode.tsx": `
        export function BrowserNode({ copy }) {
          return <button aria-label={copy.t("actions.reload")}>{copy.t("title")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /i18n check passed/);
});

test("checks packages whose manifest name is not one of the built-in names", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    packageFiles: {
      "packages/workspace/terminal/src/i18n/terminalNodeI18n.ts": `
        import { createScopedLocaleObjectsI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

        export const terminalNodeI18nNamespace = "terminalNode";
        export const terminalNodeI18nModule = createScopedLocaleObjectsI18nModuleManifest({
          localeObjectByLocale: {
            en: "terminalNodeEn",
            "zh-CN": "terminalNodeZhCN"
          },
          name: "workspace-terminal",
          namespace: terminalNodeI18nNamespace,
          sourceRoot: "packages/workspace/terminal/src"
        });

        const terminalNodeEn = {
          status: {
            running: "Running"
          }
        } as const;

        const terminalNodeZhCN = {
          status: {}
        } as const;
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locale-key-missing/);
  assert.match(result.stderr, /terminalNode\.status\.running/);
});

test("skips runtime-composed keys and placeholder-only copy", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    rendererFiles: {
      "app/Status.tsx": `
        export function Status({ status, label, t }) {
          const mention = { label: \\\`@\\\${label}\\\` };
          return <span aria-label={mention.label}>{t(\\\`status.\\\${status}\\\`)}</span>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /i18n check passed/);
});

test("accepts package locale-object manifests with source roots", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    packageFiles: {
      "packages/agent/gui/app/renderer/i18n/index.ts": `
        import { createLocaleObjectI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

        export const agentGuiI18nModule = createLocaleObjectI18nModuleManifest({
          fileByLocale: {
            en: "packages/agent/gui/app/renderer/i18n/locales/en.ts",
            "zh-CN": "packages/agent/gui/app/renderer/i18n/locales/zh-CN.ts"
          },
          name: "agent-gui",
          sourceRoot: "packages/agent/gui"
        });
      `,
      "packages/agent/gui/app/renderer/i18n/locales/en.ts": `
        export const en = {
          common: {
            home: "Home"
          }
        } as const;
      `,
      "packages/agent/gui/app/renderer/i18n/locales/zh-CN.ts": `
        export const zhCN = {
          common: {
            home: "首页"
          }
        } as const;
      `,
      "packages/agent/gui/shared/workspaceFileManager/workspaceFileManagerModel.ts": `
        export function buildBreadcrumb(copy) {
          return [{ label: copy.t("common.home"), path: "/" }];
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /i18n check passed/);
});

test("rejects missing copy.t keys from shared package resources", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    packageFiles: {
      "packages/workspace/file-manager/src/ui/FileManager.tsx": `
        export function FileManager({ copy }) {
          return <button>{copy.t("missingLabel")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /i18n-key-missing/);
  assert.match(result.stderr, /missingLabel/);
});

test("rejects package locale placeholder mismatches across locales", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    workspaceFileManagerZhCN: `
      const workspaceFileManagerZhCN = {
        uploadLabel: "上传",
        uploadConflictDescription: "存在冲突"
      } as const;
    `
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /locale-placeholder/);
  assert.match(result.stderr, /workspaceFileManager.uploadConflictDescription/);
});

test("still validates translator.t desktop keys", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    main: `
      export function openDialog(translator) {
        return translator.t("common.missingButton");
      }
    `
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /i18n-key-missing/);
  assert.match(result.stderr, /common.missingButton/);
});

test("rejects generated i18n key names", async () => {
  const workspaceRoot = await createFixtureWorkspace({
    en: `
      export const en = {
        common: {
          hello: "Hello",
          readyStatus: "{{count}} ready",
          submitButton: "Submit",
          l12c34: "Generated key"
        }
      } as const;
    `,
    zhCN: `
      export const zhCN = {
        common: {
          hello: "你好",
          readyStatus: "已就绪 {{count}} 个",
          submitButton: "提交",
          l12c34: "生成键"
        }
      } as const;
    `,
    rendererFiles: {
      "app/App.tsx": `
        export function App() {
          const { t } = useTranslation();
          return <button>{t("common.l12c34")}</button>;
        }
      `
    }
  });

  const result = runI18nCheck(workspaceRoot);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /i18n-key-semantic/);
  assert.match(result.stderr, /common.l12c34/);
});

async function createFixtureWorkspace(options = {}) {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tutti-i18n-"));
  const files = {
    "apps/desktop/src/shared/i18n/locales/en.ts":
      options.en ?? defaultEnglishLocale(),
    "apps/desktop/src/shared/i18n/locales/zh-CN.ts":
      options.zhCN ?? defaultChineseLocale(),
    "apps/desktop/src/shared/i18n/i18nManifest.ts":
      defaultDesktopI18nManifest(),
    "apps/desktop/src/main/index.ts":
      options.main ?? "export const main = true;\n",
    "packages/workspace/file-manager/src/i18n/workspaceFileManagerI18n.ts":
      defaultWorkspaceFileManagerI18n(options.workspaceFileManagerZhCN),
    "packages/workbench/surface/src/host/workbenchHostI18n.ts":
      defaultWorkbenchHostI18n(),
    "packages/workbench/surface/src/react/workbenchWindowI18n.ts":
      defaultWorkbenchWindowI18n()
  };

  const rendererFiles = options.rendererFiles ?? {
    "app/App.tsx": `
      export function App() {
        const { t } = useTranslation();
        return <span>{t("common.hello")}</span>;
      }
    `
  };

  for (const [path, content] of Object.entries(rendererFiles)) {
    files[`apps/desktop/src/renderer/src/${path}`] = content;
  }

  for (const [path, content] of Object.entries(options.packageFiles ?? {})) {
    files[path] = content;
  }

  for (const [path, content] of Object.entries(files)) {
    const absolutePath = join(workspaceRoot, path);
    await mkdir(dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, `${content.trim()}\n`, "utf8");
  }

  return workspaceRoot;
}

function defaultEnglishLocale() {
  return `
    export const en = {
      common: {
        hello: "Hello",
        readyStatus: "{{count}} ready",
        submitButton: "Submit"
      }
    } as const;
  `;
}

function defaultChineseLocale() {
  return `
    export const zhCN = {
      common: {
        hello: "你好",
        readyStatus: "已就绪 {{count}} 个",
        submitButton: "提交"
      }
    } as const;
  `;
}

function defaultDesktopI18nManifest() {
  return `
    import { createLocaleObjectI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

    export const tuttiI18nModule = createLocaleObjectI18nModuleManifest({
      fileByLocale: {
        en: "apps/desktop/src/shared/i18n/locales/en.ts",
        "zh-CN": "apps/desktop/src/shared/i18n/locales/zh-CN.ts"
      },
      name: "desktop-locales"
    });
  `;
}

function defaultWorkspaceFileManagerI18n(zhCNOverride) {
  return `
    import { createScopedLocaleObjectsI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

    export const workspaceFileManagerI18nNamespace = "workspaceFileManager";
    export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
      localeObjectByLocale: {
        en: "workspaceFileManagerEn",
        "zh-CN": "workspaceFileManagerZhCN"
      },
      name: "workspace-file-manager",
      namespace: "workspaceFileManager",
      sourceRoot: "packages/workspace/file-manager/src"
    });

    const workspaceFileManagerEn = {
      uploadLabel: "Upload",
      uploadConflictDescription: "{{count}} conflicts"
    } as const;

    ${(
      zhCNOverride ??
      `
    const workspaceFileManagerZhCN = {
      uploadLabel: "上传",
      uploadConflictDescription: "{{count}} 个冲突"
    } as const;
    `
    ).trim()}

    export const workspaceFileManagerI18nResources = {
      en: {
        [workspaceFileManagerI18nNamespace]: workspaceFileManagerEn
      },
      "zh-CN": {
        [workspaceFileManagerI18nNamespace]: workspaceFileManagerZhCN
      }
    } as const;
  `;
}

function defaultWorkbenchWindowI18n() {
  return `
    import { createScopedLocaleObjectsI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

    export const workbenchWindowChromeI18nNamespace = "workbenchWindowChrome";
    export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
      localeObjectByLocale: {
        en: "workbenchWindowChromeEn",
        "zh-CN": "workbenchWindowChromeZhCN"
      },
      name: "workbench-window-chrome",
      namespace: "workbenchWindowChrome",
      sourceRoot: "packages/workbench/surface/src"
    });

    const workbenchWindowChromeEn = {
      layoutMenu: "Window layout"
    } as const;

    const workbenchWindowChromeZhCN = {
      layoutMenu: "窗口布局"
    } as const;

    export const workbenchWindowChromeI18nResources = {
      en: {
        [workbenchWindowChromeI18nNamespace]: workbenchWindowChromeEn
      },
      "zh-CN": {
        [workbenchWindowChromeI18nNamespace]: workbenchWindowChromeZhCN
      }
    } as const;
  `;
}

function defaultWorkbenchHostI18n() {
  return `
    import { createScopedLocaleObjectsI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

    export const workbenchHostI18nNamespace = "workbenchHost";
    export const tuttiI18nModule = createScopedLocaleObjectsI18nModuleManifest({
      localeObjectByLocale: {
        en: "workbenchHostEn",
        "zh-CN": "workbenchHostZhCN"
      },
      name: "workbench-host",
      namespace: "workbenchHost",
      sourceRoot: "packages/workbench/surface/src"
    });

    const workbenchHostEn = {
      actions: {
        close: "Close",
        minimize: "Minimize"
      },
      dockLabel: "Workbench dock",
      launch: "Open {{title}}"
    } as const;

    const workbenchHostZhCN = {
      actions: {
        close: "关闭",
        minimize: "最小化"
      },
      dockLabel: "工作台程序坞",
      launch: "打开 {{title}}"
    } as const;

    export const workbenchHostI18nResources = {
      en: {
        [workbenchHostI18nNamespace]: workbenchHostEn
      },
      "zh-CN": {
        [workbenchHostI18nNamespace]: workbenchHostZhCN
      }
    } as const;
  `;
}

function defaultBrowserNodeI18n() {
  return `
    import { createScopedLocaleObjectsI18nModuleManifest } from "@tutti-os/ui-i18n-runtime";

    export const browserNodeI18nNamespace = "browserNode";
    export const browserNodeI18nModule = createScopedLocaleObjectsI18nModuleManifest({
      localeObjectByLocale: {
        en: "browserNodeEn",
        "zh-CN": "browserNodeZhCN"
      },
      name: "browser-node",
      namespace: "browserNode",
      sourceRoot: "packages/browser/workbench-node/src"
    });

    const browserNodeEn = {
      actions: {
        reload: "Reload"
      },
      title: "Browser"
    } as const;

    const browserNodeZhCN = {
      actions: {
        reload: "重新加载"
      },
      title: "浏览器"
    } as const;
  `;
}

function runI18nCheck(workspaceRoot) {
  return spawnSync(process.execPath, [scriptPath], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      TUTTI_WORKSPACE_ROOT: workspaceRoot
    }
  });
}
