import assert from "node:assert/strict";
import test from "node:test";
import { applyDesktopElectronPlatformCompatibility } from "./electronPlatformCompatibility.ts";

test("desktop Electron compatibility keeps Linux on X11", () => {
  const switches: Array<[string, string | undefined]> = [];

  applyDesktopElectronPlatformCompatibility(
    {
      appendSwitch(name, value) {
        switches.push([name, value]);
      }
    },
    "linux"
  );

  assert.deepEqual(switches, [["ozone-platform", "x11"]]);
});

test("desktop Electron compatibility leaves non-Linux platforms unchanged", () => {
  const switches: Array<[string, string | undefined]> = [];

  applyDesktopElectronPlatformCompatibility(
    {
      appendSwitch(name, value) {
        switches.push([name, value]);
      }
    },
    "darwin"
  );

  assert.deepEqual(switches, []);
});
