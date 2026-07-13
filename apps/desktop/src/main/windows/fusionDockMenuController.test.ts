import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import {
  createFusionDockMenuController,
  type FusionDockMenuController
} from "./fusionDockMenuController.ts";

test("Fusion Dock menu refreshes locale, workspace actions, and installed menu", () => {
  let locale: "en" | "zh-CN" = "en";
  const installedMenus: MenuItemConstructorOptions[][] = [];
  const actions: string[] = [];
  const controller = createFusionDockMenuController({
    buildMenu: (template) => template,
    dock: {
      setMenu(menu) {
        installedMenus.push(menu);
      }
    },
    getLocale: () => locale,
    onBackgroundTasks: () => actions.push("background"),
    onNewWindow: (kind, workspaceId) =>
      actions.push(`new:${workspaceId}:${kind}`),
    onOpenSettings: (workspaceId) => actions.push(`settings:${workspaceId}`),
    onShowDock: () => actions.push("show")
  });

  controller.refresh("workspace-a");
  assert.equal(installedMenus.length, 1);
  assert.equal(installedMenus[0]?.[0]?.label, "Show Dock");
  clickMenuItem(requireSubmenu(installedMenus[0]?.[1])[1]);
  clickMenuItem(installedMenus[0]?.[4]);

  locale = "zh-CN";
  controller.refresh("workspace-b");
  assert.equal(installedMenus.length, 2);
  assert.equal(installedMenus[1]?.[0]?.label, "显示 Dock");
  clickMenuItem(requireSubmenu(installedMenus[1]?.[1])[2]);
  clickMenuItem(installedMenus[1]?.[4]);

  assert.deepEqual(actions, [
    "new:workspace-a:terminal",
    "settings:workspace-a",
    "new:workspace-b:browser",
    "settings:workspace-b"
  ]);

  controller.dispose();
  assert.deepEqual(installedMenus.at(-1), []);
});

test("Fusion Dock menu is inert when the application Dock is unavailable", () => {
  let buildCount = 0;
  const controller: FusionDockMenuController = createFusionDockMenuController({
    buildMenu(template) {
      buildCount += 1;
      return template;
    },
    dock: null,
    getLocale: () => "en",
    onBackgroundTasks() {},
    onNewWindow() {},
    onOpenSettings() {},
    onShowDock() {}
  });

  controller.refresh("workspace-a");
  controller.dispose();

  assert.equal(buildCount, 0);
});

test("Fusion Dock menu does not clear application state unless it was installed", () => {
  const installedMenus: MenuItemConstructorOptions[][] = [];
  const controller = createFusionDockMenuController({
    buildMenu: (template) => template,
    dock: {
      setMenu(menu) {
        installedMenus.push(menu);
      }
    },
    getLocale: () => "en",
    onBackgroundTasks() {},
    onNewWindow() {},
    onOpenSettings() {},
    onShowDock() {}
  });

  controller.dispose();

  assert.deepEqual(installedMenus, []);
});

function clickMenuItem(item: MenuItemConstructorOptions | undefined): void {
  assert.ok(item);
  const click = item.click as (() => void) | undefined;
  assert.ok(click);
  click();
}

function requireSubmenu(
  item: MenuItemConstructorOptions | undefined
): MenuItemConstructorOptions[] {
  assert.ok(item);
  assert.ok(Array.isArray(item.submenu));
  return item.submenu;
}
