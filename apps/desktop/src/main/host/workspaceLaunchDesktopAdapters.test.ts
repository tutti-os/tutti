import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  awaitWorkspaceWindowReady,
  type WorkspaceWindowReadyTarget
} from "./workspaceWindowReady.ts";

test("workspace window readiness handles ready-to-show emitted during load start", async () => {
  const target = createWorkspaceWindowReadyTarget();

  await awaitWorkspaceWindowReady(target.window, () => {
    target.emit("ready-to-show");
  });

  assert.equal(target.maximizeCount, 1);
  assert.equal(target.showCount, 1);
});

test("workspace window readiness rejects failed loads emitted during load start", async () => {
  const target = createWorkspaceWindowReadyTarget();

  await assert.rejects(
    awaitWorkspaceWindowReady(target.window, () => {
      target.emit("did-fail-load", {}, -6, "ERR_FILE_NOT_FOUND");
    }),
    /Replacement window failed to load \(-6\): ERR_FILE_NOT_FOUND/
  );

  assert.equal(target.closeCount, 1);
});

test("workspace window readiness shows when load completes without ready-to-show", async () => {
  const target = createWorkspaceWindowReadyTarget();

  await awaitWorkspaceWindowReady(target.window, () => {
    target.emit("did-finish-load");
  });

  assert.equal(target.maximizeCount, 1);
  assert.equal(target.showCount, 1);
});

test("workspace window readiness can show without maximizing", async () => {
  const target = createWorkspaceWindowReadyTarget();

  await awaitWorkspaceWindowReady(
    target.window,
    () => {
      target.emit("ready-to-show");
    },
    { maximizeOnShow: false }
  );

  assert.equal(target.maximizeCount, 0);
  assert.equal(target.showCount, 1);
});

interface WorkspaceWindowReadyTargetFixture {
  closeCount: number;
  emit: (event: string, ...args: unknown[]) => void;
  maximizeCount: number;
  showCount: number;
  window: WorkspaceWindowReadyTarget;
}

function createWorkspaceWindowReadyTarget(): WorkspaceWindowReadyTargetFixture {
  const windowEvents = new EventEmitter();
  const webContentsEvents = new EventEmitter();
  const fixture: WorkspaceWindowReadyTargetFixture = {
    closeCount: 0,
    maximizeCount: 0,
    showCount: 0,
    window: {
      close() {
        fixture.closeCount += 1;
      },
      isDestroyed() {
        return false;
      },
      isVisible() {
        return false;
      },
      maximize() {
        fixture.maximizeCount += 1;
      },
      once(event: string, listener: (...args: unknown[]) => void) {
        windowEvents.once(event, listener);
        return fixture.window;
      },
      removeListener(event: string, listener: (...args: unknown[]) => void) {
        windowEvents.removeListener(event, listener);
        return fixture.window;
      },
      show() {
        fixture.showCount += 1;
      },
      webContents: {
        isDestroyed() {
          return false;
        },
        once(event: string, listener: (...args: unknown[]) => void) {
          webContentsEvents.once(event, listener);
          return fixture.window.webContents;
        },
        removeListener(event: string, listener: (...args: unknown[]) => void) {
          webContentsEvents.removeListener(event, listener);
          return fixture.window.webContents;
        }
      }
    },
    emit(event: string, ...args: unknown[]) {
      if (event === "did-fail-load" || event === "did-finish-load") {
        webContentsEvents.emit(event, ...args);
        return;
      }
      windowEvents.emit(event, ...args);
    }
  };

  return fixture;
}
