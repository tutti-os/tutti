import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { assertDesktopIpcMainFrame } from "./mainFrameAccess.ts";

test("desktop IPC accepts only the sender main frame", () => {
  const mainFrame = { processId: 10, routingId: 20 };
  assert.doesNotThrow(() =>
    assertDesktopIpcMainFrame({ sender: { mainFrame }, senderFrame: mainFrame })
  );
  assert.throws(
    () =>
      assertDesktopIpcMainFrame({
        sender: { mainFrame },
        senderFrame: { processId: 10, routingId: 21 }
      }),
    /main frame/
  );
  assert.throws(
    () =>
      assertDesktopIpcMainFrame({ sender: { mainFrame }, senderFrame: null }),
    /main frame/
  );
});

test("desktop invoke handlers use the main-frame-enforcing registrar", async () => {
  const directory = new URL("./", import.meta.url);
  const filenames = (await readdir(directory)).filter(
    (filename) =>
      filename.endsWith(".ts") &&
      !filename.endsWith(".test.ts") &&
      filename !== "handle.ts"
  );
  const sources = await Promise.all(
    filenames.map(async (filename) => ({
      filename,
      source: await readFile(new URL(filename, directory), "utf8")
    }))
  );

  for (const { filename, source } of sources) {
    assert.doesNotMatch(
      source,
      /ipcMain\.handle\s*\(/,
      `${filename} bypasses registerDesktopIpcHandler`
    );
  }
});
