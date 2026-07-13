import assert from "node:assert/strict";
import test from "node:test";
import type { MenuItemConstructorOptions } from "electron";
import { createTranslator } from "../../shared/i18n/index.ts";
import {
  createFusionDockMenuTemplate,
  createFusionTrayMenuTemplate
} from "./fusionTrayMenu.ts";

test("Fusion macOS Dock menu reuses launcher actions without duplicating Quit", () => {
  const actions: string[] = [];
  const menu = createFusionDockMenuTemplate({
    onBackgroundTasks: () => actions.push("background"),
    onNewWindow: (kind) => actions.push(`new:${kind}`),
    onOpenSettings: () => actions.push("settings"),
    onShowDock: () => actions.push("show"),
    translator: createTranslator("en"),
    workspaceAvailable: true
  });

  assert.deepEqual(
    menu.map((item) => item.label ?? item.type),
    ["Show Dock", "New window", "Background tasks", "separator", "Settings"]
  );
  assert.equal(
    menu.some((item) => item.label === "Quit Tutti"),
    false
  );

  clickMenuItem(menu[0]);
  clickMenuItem(menu[2]);
  clickMenuItem(menu[4]);
  const newWindowMenu = requireSubmenu(menu[1]);
  clickMenuItem(newWindowMenu[0]);

  assert.deepEqual(actions, ["show", "background", "settings", "new:agent"]);
});

test("Fusion tray menu retains Quit while sharing localized launcher items", () => {
  const menu = createFusionTrayMenuTemplate({
    onBackgroundTasks() {},
    onNewWindow() {},
    onOpenSettings() {},
    onQuit() {},
    onShowDock() {},
    translator: createTranslator("zh-CN"),
    workspaceAvailable: true
  });

  assert.deepEqual(
    menu.map((item) => item.label ?? item.type),
    [
      "显示 Dock",
      "新建窗口",
      "后台任务",
      "separator",
      "设置",
      "separator",
      "退出 Tutti"
    ]
  );
});

test("Fusion launcher menus disable workspace-scoped actions without a workspace", () => {
  const menu = createFusionDockMenuTemplate({
    onBackgroundTasks() {},
    onNewWindow() {},
    onOpenSettings() {},
    onShowDock() {},
    translator: createTranslator("en"),
    workspaceAvailable: false
  });

  assert.equal(menu[1]?.enabled, false);
  assert.equal(menu[4]?.enabled, false);
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
