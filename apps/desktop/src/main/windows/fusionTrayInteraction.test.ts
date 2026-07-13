import assert from "node:assert/strict";
import test from "node:test";
import {
  createFusionTrayInteractionHandlers,
  showFusionTrayContextMenu
} from "./fusionTrayInteraction.ts";

test("ordinary Tray clicks toggle the Fusion Dock without opening the menu", () => {
  const calls: string[] = [];
  const handlers = createFusionTrayInteractionHandlers({
    openContextMenu: () => calls.push("menu"),
    toggleDock: () => calls.push("toggle")
  });

  handlers.handleClick({});

  assert.deepEqual(calls, ["toggle"]);
});

test("control-click and context-menu gestures open the Tray menu", () => {
  const calls: string[] = [];
  const handlers = createFusionTrayInteractionHandlers({
    openContextMenu: () => calls.push("menu"),
    toggleDock: () => calls.push("toggle")
  });

  handlers.handleClick({ ctrlKey: true });
  handlers.handleContextMenu();

  assert.deepEqual(calls, ["menu", "menu"]);
});

test("Tray context menus use native Tray popup with a Linux Menu fallback", () => {
  const calls: string[] = [];
  const menu = { popup: () => calls.push("menu-popup") };
  const tray = {
    popUpContextMenu: () => calls.push("tray-popup")
  };

  showFusionTrayContextMenu({ menu, platform: "darwin", tray });
  showFusionTrayContextMenu({ menu, platform: "linux", tray });

  assert.deepEqual(calls, ["tray-popup", "menu-popup"]);
});
