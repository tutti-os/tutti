import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  resolveTerminalLinkAbsolutePath,
  resolveWorkspaceFileAbsolutePath,
  resolveWorkspaceLogicalFilePath
} from "./workspaceFilePaths.ts";

test("resolveWorkspaceFileAbsolutePath maps the local workspace root", () => {
  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "/tmp/demo",
      rootDirectory: "/tmp/demo"
    }),
    path.resolve("/tmp/demo")
  );
});

test("resolveWorkspaceFileAbsolutePath maps file paths under the local root", () => {
  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "/tmp/demo/src/App.tsx",
      rootDirectory: "/tmp/demo"
    }),
    path.resolve("/tmp/demo/src/App.tsx")
  );
});

test("resolveWorkspaceFileAbsolutePath rejects absolute paths outside the local root", () => {
  assert.throws(
    () =>
      resolveWorkspaceFileAbsolutePath({
        logicalPath: "/tmp/other/App.tsx",
        rootDirectory: "/tmp/demo"
      }),
    /escapes root directory/
  );
});

test("resolveWorkspaceFileAbsolutePath normalizes relative-looking paths under the local root", () => {
  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "src\\App.tsx",
      rootDirectory: "/tmp/demo"
    }),
    path.resolve("/tmp/demo/src/App.tsx")
  );
});

test("resolveWorkspaceFileAbsolutePath normalizes daemon Windows drive paths", () => {
  if (process.platform !== "win32") {
    return;
  }

  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "/C:/Users/test/Documents/notes.txt",
      rootDirectory: "C:\\"
    }),
    path.resolve("C:/Users/test/Documents/notes.txt")
  );
});

test("resolveWorkspaceFileAbsolutePath normalizes Git Bash drive paths", () => {
  if (process.platform !== "win32") {
    return;
  }

  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "/c/Users/test/Documents/notes.txt",
      rootDirectory: "C:\\"
    }),
    path.resolve("C:/Users/test/Documents/notes.txt")
  );
});

test("resolveWorkspaceFileAbsolutePath keeps Git Bash paths on another drive outside the root", () => {
  if (process.platform !== "win32") {
    return;
  }

  assert.throws(
    () =>
      resolveWorkspaceFileAbsolutePath({
        logicalPath: "/d/Users/test/Documents/notes.txt",
        rootDirectory: "C:\\"
      }),
    /escapes root directory/
  );
});

test("resolveWorkspaceFileAbsolutePath preserves native and UNC Windows paths", () => {
  if (process.platform !== "win32") {
    return;
  }

  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "C:\\Users\\test\\Documents\\notes.txt",
      rootDirectory: "C:\\"
    }),
    path.resolve("C:/Users/test/Documents/notes.txt")
  );
  assert.equal(
    resolveWorkspaceFileAbsolutePath({
      logicalPath: "\\\\server\\share\\Documents\\notes.txt",
      rootDirectory: "\\\\server\\share"
    }),
    path.resolve("\\\\server\\share\\Documents\\notes.txt")
  );
});

test("resolveWorkspaceFileAbsolutePath rejects empty workspace roots", () => {
  assert.throws(
    () =>
      resolveWorkspaceFileAbsolutePath({
        logicalPath: "/tmp/demo/src/App.tsx",
        rootDirectory: "   "
      }),
    /root directory is required/
  );
});

test("resolveWorkspaceFileAbsolutePath treats /workspace as an ordinary absolute path", () => {
  assert.throws(
    () =>
      resolveWorkspaceFileAbsolutePath({
        logicalPath: "/workspace/src/App.tsx",
        rootDirectory: "/tmp/demo"
      }),
    /escapes root directory/
  );
});

test("resolveWorkspaceLogicalFilePath maps /workspace paths onto the physical root", () => {
  assert.equal(
    resolveWorkspaceLogicalFilePath({
      logicalPath: "/workspace/Desktop/notes.txt",
      physicalRootDirectory: "/Users/demo"
    }),
    path.resolve("/Users/demo/Desktop/notes.txt")
  );
});

test("resolveTerminalLinkAbsolutePath supports home-relative, absolute, and cwd-relative paths", () => {
  assert.equal(
    resolveTerminalLinkAbsolutePath({
      defaultDirectory: "/Users/example",
      homeDirectory: "/Users/example",
      path: "~/tmp/app.log"
    }),
    path.resolve("/Users/example/tmp/app.log")
  );
  assert.equal(
    resolveTerminalLinkAbsolutePath({
      defaultDirectory: "/Users/example",
      homeDirectory: "/Users/example",
      path: "/tmp/app.log"
    }),
    path.resolve("/tmp/app.log")
  );
  assert.equal(
    resolveTerminalLinkAbsolutePath({
      cwd: "/tmp/demo/src",
      defaultDirectory: "/Users/example",
      homeDirectory: "/Users/example",
      path: "../README.md"
    }),
    path.resolve("/tmp/demo/README.md")
  );
});

test("resolveTerminalLinkAbsolutePath preserves POSIX /c paths", () => {
  if (process.platform === "win32") {
    return;
  }

  assert.equal(
    resolveTerminalLinkAbsolutePath({
      defaultDirectory: "/Users/example",
      homeDirectory: "/Users/example",
      path: "/c/Users/example/notes.txt"
    }),
    path.resolve("/c/Users/example/notes.txt")
  );
});

test("resolveTerminalLinkAbsolutePath normalizes Git Bash drive paths", () => {
  if (process.platform !== "win32") {
    return;
  }

  assert.equal(
    resolveTerminalLinkAbsolutePath({
      cwd: "C:\\Users\\test\\project",
      defaultDirectory: "C:\\Users\\test",
      homeDirectory: "C:\\Users\\test",
      path: "/c/Users/test/project/notes.txt"
    }),
    path.resolve("C:/Users/test/project/notes.txt")
  );
});
