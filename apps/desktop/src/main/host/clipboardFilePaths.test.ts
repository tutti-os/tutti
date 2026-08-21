import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWindowsFileDropBuffer,
  normalizeClipboardFilePaths
} from "./clipboardFilePaths.ts";

test("normalizes workspace API drive paths before Windows clipboard access", () => {
  assert.deepEqual(
    normalizeClipboardFilePaths(
      [" /C:/Users/15514/Documents/tutti ", "C:/Users/15514/Documents/tutti"],
      "win32"
    ),
    ["C:\\Users\\15514\\Documents\\tutti"]
  );
});

test("preserves absolute POSIX clipboard paths", () => {
  assert.deepEqual(
    normalizeClipboardFilePaths([" /Users/test/Documents/tutti "], "darwin"),
    ["/Users/test/Documents/tutti"]
  );
});

test("builds a wide Windows DROPFILES payload", () => {
  const buffer = buildWindowsFileDropBuffer([
    "C:\\Users\\15514\\Documents\\tutti",
    "D:\\Shared\\notes.txt"
  ]);

  assert.equal(buffer.readUInt32LE(0), 20);
  assert.equal(buffer.readInt32LE(4), 0);
  assert.equal(buffer.readInt32LE(8), 0);
  assert.equal(buffer.readInt32LE(12), 0);
  assert.equal(buffer.readInt32LE(16), 1);
  assert.equal(
    buffer.subarray(20).toString("utf16le"),
    "C:\\Users\\15514\\Documents\\tutti\0D:\\Shared\\notes.txt\0\0"
  );
  assert.deepEqual(buffer.subarray(-4), Buffer.alloc(4));
});
