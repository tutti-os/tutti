jest.mock("./mobileNative", () => ({ mobileSecurity: {} }));

import { parseMobileUpdateProgress } from "./mobileUpdateNativeBridge";

test("parses a valid native update progress event", () => {
  expect(
    parseMobileUpdateProgress({
      downloadedBytes: 512,
      errorCode: null,
      indeterminate: false,
      phase: "downloading",
      totalBytes: 1024
    })
  ).toEqual({
    downloadedBytes: 512,
    errorCode: null,
    indeterminate: false,
    phase: "downloading",
    totalBytes: 1024
  });
});

test("ignores malformed native update progress events", () => {
  expect(
    parseMobileUpdateProgress({
      downloadedBytes: -1,
      indeterminate: false,
      phase: "downloading",
      totalBytes: 1024
    })
  ).toBeNull();
  expect(
    parseMobileUpdateProgress({
      downloadedBytes: 0,
      indeterminate: true,
      phase: "unknown",
      totalBytes: null
    })
  ).toBeNull();
});
