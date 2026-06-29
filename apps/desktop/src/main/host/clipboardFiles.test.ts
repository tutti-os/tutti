import assert from "node:assert/strict";
import test from "node:test";
import { writeImageToClipboardWriter } from "./clipboardImageWriter.ts";
import { buildFilenamesPlist } from "./clipboardFilePlist.ts";

test("buildFilenamesPlist escapes special characters", () => {
  const plist = buildFilenamesPlist(["/Users/demo/Desktop/a&b<file>.txt"]);

  assert.match(plist, /a&amp;b&lt;file&gt;\.txt/);
  assert.match(plist, /<array>/);
});

test("writeImageToSystemClipboard clears stale clipboard formats before writing image", () => {
  const calls: string[] = [];
  const image = {
    isEmpty: () => false
  };

  writeImageToClipboardWriter(
    {
      data: Buffer.from("png").toString("base64"),
      mimeType: "image/png"
    },
    {
      clipboard: {
        clear() {
          calls.push("clear");
        },
        writeImage(value) {
          assert.equal(value, image);
          calls.push("writeImage");
        }
      },
      nativeImage: {
        createFromBuffer(buffer) {
          assert.deepEqual(buffer, Buffer.from("png"));
          return image;
        }
      }
    }
  );

  assert.deepEqual(calls, ["clear", "writeImage"]);
});
