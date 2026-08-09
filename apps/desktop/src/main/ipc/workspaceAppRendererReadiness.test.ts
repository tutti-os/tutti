import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import type { BrowserWindow, IpcMainEvent } from "electron";
import { desktopIpcChannels } from "../../shared/contracts/ipc.ts";
import {
  createWorkspaceAppRendererReadiness,
  isWorkspaceAppExternalRendererReadiness
} from "./workspaceAppRendererReadiness.ts";

class FakeIpc {
  private listener:
    | ((event: IpcMainEvent, payload: unknown) => void)
    | undefined;

  off(
    channel: string,
    listener: (event: IpcMainEvent, payload: unknown) => void
  ): void {
    assert.equal(channel, desktopIpcChannels.appExternal.rendererReady);
    if (this.listener === listener) {
      this.listener = undefined;
    }
  }

  on(
    channel: string,
    listener: (event: IpcMainEvent, payload: unknown) => void
  ): void {
    assert.equal(channel, desktopIpcChannels.appExternal.rendererReady);
    this.listener = listener;
  }

  emit(sender: FakeWebContents, payload: unknown): void {
    this.listener?.({ sender } as unknown as IpcMainEvent, payload);
  }
}

class FakeWebContents extends EventEmitter {
  destroyed = false;
  readonly id: number;

  constructor(id: number) {
    super();
    this.id = id;
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }
}

function ownerWindow(webContents: FakeWebContents): BrowserWindow {
  return { webContents } as unknown as BrowserWindow;
}

test("workspace owner requests wait until the renderer handler announces readiness", async () => {
  const ipc = new FakeIpc();
  const readiness = createWorkspaceAppRendererReadiness({ ipc, timeoutMs: 50 });
  const webContents = new FakeWebContents(17);
  let settled = false;
  const waiting = readiness.waitFor(ownerWindow(webContents)).then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.equal(settled, false);
  ipc.emit(webContents, { ready: true });
  await waiting;
  assert.equal(settled, true);

  readiness.dispose();
});

test("workspace renderer readiness is cleared when its request handler detaches", async () => {
  const ipc = new FakeIpc();
  const readiness = createWorkspaceAppRendererReadiness({ ipc, timeoutMs: 50 });
  const webContents = new FakeWebContents(23);
  ipc.emit(webContents, { ready: true });
  await readiness.waitFor(ownerWindow(webContents));

  ipc.emit(webContents, { ready: false });
  const waiting = readiness.waitFor(ownerWindow(webContents));
  webContents.destroyed = true;
  webContents.emit("destroyed");
  await assert.rejects(waiting, /renderer is unavailable/);

  readiness.dispose();
});

test("workspace renderer readiness payloads require a boolean ready state", () => {
  assert.equal(isWorkspaceAppExternalRendererReadiness({ ready: true }), true);
  assert.equal(
    isWorkspaceAppExternalRendererReadiness({ ready: "yes" }),
    false
  );
  assert.equal(isWorkspaceAppExternalRendererReadiness(null), false);
});
