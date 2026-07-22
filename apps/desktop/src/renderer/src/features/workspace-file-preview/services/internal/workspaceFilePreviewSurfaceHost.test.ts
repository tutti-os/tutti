import assert from "node:assert/strict";
import test from "node:test";
import type { WorkspaceFilePreviewTarget } from "@tutti-os/workspace-file-preview";
import { WorkspaceFilePreviewSurfaceHost } from "./workspaceFilePreviewSurfaceHost.ts";

const target: WorkspaceFilePreviewTarget = {
  previewKind: "text",
  mtimeMs: null,
  name: "notes.txt",
  path: "/workspace/notes.txt",
  sizeBytes: 5
};

test("workspace file preview surface host routes presentation by workspace", async () => {
  const calls: string[] = [];
  const host = new WorkspaceFilePreviewSurfaceHost();
  host.registerPresenter("workspace-1", {
    present: (request) => {
      calls.push(request.path);
      return true;
    },
    unsupportedFallbackNotification: "show"
  });

  assert.deepEqual(await host.present("workspace-1", target), {
    presented: true,
    unsupportedFallbackNotification: "show"
  });
  assert.deepEqual(await host.present("workspace-2", target), {
    presented: false,
    unsupportedFallbackNotification: "show"
  });
  assert.deepEqual(calls, [target.path]);
});

test("workspace file preview surface host keeps a replacement after stale disposal", async () => {
  const host = new WorkspaceFilePreviewSurfaceHost();
  const disposeFirst = host.registerPresenter("workspace-1", {
    present: () => false,
    unsupportedFallbackNotification: "show"
  });
  host.registerPresenter("workspace-1", {
    present: () => true,
    unsupportedFallbackNotification: "suppress"
  });

  disposeFirst();

  assert.equal((await host.present("workspace-1", target)).presented, true);
  assert.equal(
    host.getUnsupportedFallbackNotification("workspace-1"),
    "suppress"
  );
});

test("workspace file preview surface host distinguishes repeated registrations", async () => {
  const host = new WorkspaceFilePreviewSurfaceHost();
  const presenter = {
    present: () => true,
    unsupportedFallbackNotification: "show" as const
  };
  const disposeFirst = host.registerPresenter("workspace-1", presenter);
  host.registerPresenter("workspace-1", presenter);

  disposeFirst();

  assert.equal((await host.present("workspace-1", target)).presented, true);
});

test("workspace file preview surface host restores default fallback notification policy after disposal", () => {
  const host = new WorkspaceFilePreviewSurfaceHost();
  const dispose = host.registerPresenter("workspace-1", {
    present: () => true,
    unsupportedFallbackNotification: "suppress"
  });

  assert.equal(
    host.getUnsupportedFallbackNotification("workspace-1"),
    "suppress"
  );
  dispose();
  assert.equal(host.getUnsupportedFallbackNotification("workspace-1"), "show");
});

test("workspace file preview surface host preserves a completed presentation after replacement", async () => {
  const host = new WorkspaceFilePreviewSurfaceHost();
  let finishPresentation: ((value: boolean) => void) | undefined;
  host.registerPresenter("workspace-1", {
    present: () =>
      new Promise<boolean>((resolve) => {
        finishPresentation = resolve;
      }),
    unsupportedFallbackNotification: "show"
  });

  const presented = host.present("workspace-1", target);
  host.registerPresenter("workspace-1", {
    present: () => true,
    unsupportedFallbackNotification: "show"
  });
  finishPresentation?.(true);

  assert.deepEqual(await presented, {
    presented: true,
    unsupportedFallbackNotification: "show"
  });
});

test("workspace file preview surface host keeps the starting registration policy when a failed presentation completes after replacement", async () => {
  const host = new WorkspaceFilePreviewSurfaceHost();
  let finishPresentation: ((value: boolean) => void) | undefined;
  host.registerPresenter("workspace-1", {
    present: () =>
      new Promise<boolean>((resolve) => {
        finishPresentation = resolve;
      }),
    unsupportedFallbackNotification: "suppress"
  });

  const presented = host.present("workspace-1", target);
  host.registerPresenter("workspace-1", {
    present: () => true,
    unsupportedFallbackNotification: "show"
  });
  finishPresentation?.(false);

  assert.deepEqual(await presented, {
    presented: false,
    unsupportedFallbackNotification: "suppress"
  });
});
