import assert from "node:assert/strict";
import test from "node:test";
import {
  clampWorkspaceFileManagerSidebarWidth,
  readWorkspaceFileManagerPreviewWidth,
  readWorkspaceFileManagerSidebarWidth,
  resolveWorkspaceFileManagerSidebarMaxWidth,
  workspaceFileManagerContentWithoutPreviewMinWidth,
  workspaceFileManagerPreviewDefaultWidth,
  workspaceFileManagerPreviewWidthStorageKey,
  workspaceFileManagerSidebarDefaultWidth,
  workspaceFileManagerSidebarMinWidth,
  workspaceFileManagerSidebarWidthStorageKey,
  writeWorkspaceFileManagerPreviewWidth,
  writeWorkspaceFileManagerSidebarWidth
} from "./workspaceFileManagerPaneSizing.ts";

test("workspace file manager starts with the wide three-column layout", () => {
  assert.equal(workspaceFileManagerSidebarDefaultWidth, 460);
  assert.equal(workspaceFileManagerPreviewDefaultWidth, 348);
  assert.equal(
    clampWorkspaceFileManagerSidebarWidth({
      containerWidth: 1_800,
      width: workspaceFileManagerSidebarDefaultWidth
    }),
    workspaceFileManagerSidebarDefaultWidth
  );
});

test("workspace file manager keeps a useful list and detail area when resizing locations", () => {
  assert.equal(
    clampWorkspaceFileManagerSidebarWidth({
      containerWidth: 900,
      width: 500
    }),
    320
  );
  assert.equal(
    clampWorkspaceFileManagerSidebarWidth({
      containerWidth: 600,
      width: 20
    }),
    workspaceFileManagerSidebarMinWidth
  );
  assert.equal(resolveWorkspaceFileManagerSidebarMaxWidth(900), 320);
});

test("workspace file manager lets locations grow when the detail panel is hidden", () => {
  assert.equal(
    clampWorkspaceFileManagerSidebarWidth({
      containerWidth: 900,
      contentMinWidth: workspaceFileManagerContentWithoutPreviewMinWidth,
      width: 800
    }),
    580
  );
  assert.equal(
    resolveWorkspaceFileManagerSidebarMaxWidth(
      900,
      workspaceFileManagerContentWithoutPreviewMinWidth
    ),
    580
  );
});

test("workspace file manager persists both adjustable pane widths", () => {
  const storage = new Map<string, string>();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        }
      }
    }
  });

  try {
    writeWorkspaceFileManagerSidebarWidth(372);
    writeWorkspaceFileManagerPreviewWidth(416);

    assert.equal(
      storage.get(workspaceFileManagerSidebarWidthStorageKey),
      "372"
    );
    assert.equal(
      storage.get(workspaceFileManagerPreviewWidthStorageKey),
      "416"
    );
    assert.equal(readWorkspaceFileManagerSidebarWidth(), 372);
    assert.equal(readWorkspaceFileManagerPreviewWidth(), 416);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});

test("workspace file manager ignores invalid persisted pane widths", () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      localStorage: {
        getItem: (key: string) =>
          key === workspaceFileManagerSidebarWidthStorageKey ? "NaN" : "-12",
        setItem: () => {}
      }
    }
  });

  try {
    assert.equal(
      readWorkspaceFileManagerSidebarWidth(),
      workspaceFileManagerSidebarDefaultWidth
    );
    assert.equal(
      readWorkspaceFileManagerPreviewWidth(),
      workspaceFileManagerPreviewDefaultWidth
    );
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  }
});
