import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  packagedFusionTrayIconName,
  resolveFusionTrayIconPath
} from "./fusionTrayIcon.ts";

test("Fusion Tray icon resolves from app resources when packaged", () => {
  assert.equal(
    resolveFusionTrayIconPath({
      appPath: "/Applications/Tutti.app/Contents/Resources/app.asar",
      isPackaged: true,
      resourcesPath: "/Applications/Tutti.app/Contents/Resources"
    }),
    `/Applications/Tutti.app/Contents/Resources/${packagedFusionTrayIconName}`
  );
  assert.equal(
    resolveFusionTrayIconPath({
      appPath: "/repo/apps/desktop",
      isPackaged: false,
      resourcesPath: "/Electron.app/Contents/Resources"
    }),
    "/repo/apps/desktop/build/icon.png"
  );
});

test("desktop packaging ships the Fusion Tray icon outside app.asar", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8")
  ) as {
    build?: { extraResources?: Array<{ from?: string; to?: string }> };
  };
  assert.equal(
    manifest.build?.extraResources?.some(
      (entry) =>
        entry.from === "build/icon.png" &&
        entry.to === packagedFusionTrayIconName
    ),
    true
  );
});
