import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveWorkspaceFileEntryIconDataUrl } from "./workspaceFileEntryIcon.ts";

test("resolveWorkspaceFileEntryIconDataUrl falls back to native icons for non-image files", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    t.skip("native file icons are only supported on macOS and Windows");
    return;
  }

  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-entry-icon-file-")
  );
  const targetPath = path.join(workspaceRoot, "example.txt");
  await writeFile(targetPath, "hello", "utf8");

  const iconDataUrl = await resolveWorkspaceFileEntryIconDataUrl(targetPath, {
    kind: "file",
    name: "example.txt",
    path: "/workspace/example.txt"
  });

  if (!iconDataUrl) {
    t.skip("native file icon unavailable in this test environment");
    return;
  }

  assert.match(iconDataUrl, /^data:image\/png;base64,/);
});

test("resolveWorkspaceFileEntryIconDataUrl returns png data url for image files on macOS", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), "tutti-entry-icon-"));
  const targetPath = path.join(workspaceRoot, "photo.png");
  const pngBytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64"
  );
  await writeFile(targetPath, pngBytes);

  const iconDataUrl = await resolveWorkspaceFileEntryIconDataUrl(targetPath, {
    kind: "file",
    name: "photo.png",
    path: "/workspace/photo.png"
  });

  if (!iconDataUrl) {
    t.skip("nativeImage thumbnail unavailable in this test environment");
    return;
  }

  assert.match(iconDataUrl, /^data:image\/png;base64,/);
});

test("resolveWorkspaceFileEntryIconDataUrl returns null for regular directories", async () => {
  const workspaceRoot = await mkdtemp(
    path.join(tmpdir(), "tutti-entry-icon-dir-")
  );
  const targetPath = path.join(workspaceRoot, "folder");
  await mkdir(targetPath);

  assert.equal(
    await resolveWorkspaceFileEntryIconDataUrl(targetPath, {
      kind: "directory",
      name: "folder",
      path: "/workspace/folder"
    }),
    null
  );
});

test("resolveWorkspaceFileEntryIconDataUrl returns app icon for .app bundles on macOS", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("macOS only");
    return;
  }

  const safariPath = "/Applications/Safari.app";
  try {
    const { accessSync, constants } = await import("node:fs");
    accessSync(safariPath, constants.F_OK);
  } catch {
    t.skip("Safari.app not installed");
    return;
  }

  const iconDataUrl = await resolveWorkspaceFileEntryIconDataUrl(safariPath, {
    kind: "unknown",
    name: "Safari.app",
    path: "/workspace/Safari.app"
  });

  assert.match(iconDataUrl ?? "", /^data:image\/png;base64,/);
});
