#!/usr/bin/env node
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(join(rootDir, "apps/desktop/package.json"));
const electronPath = require("electron");
const bundleId = "sh.tutti.desktop.dev";
const scheme = "tutti-dev";
const appName = "Tutti Dev";
const appDir = join(
  rootDir,
  "node_modules/.cache/tutti-desktop-electron-dev-dist",
  `${appName}.app`
);
const macOSDir = join(appDir, "Contents/MacOS");
const resourcesDir = join(appDir, "Contents/Resources");
const launcherPath = join(macOSDir, "tutti-dev-launcher");
const appEntry = join(rootDir, "apps/desktop/out/main/index.js");

const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key>
  <string>en</string>
  <key>CFBundleDisplayName</key>
  <string>${appName}</string>
  <key>CFBundleExecutable</key>
  <string>tutti-dev-launcher</string>
  <key>CFBundleIdentifier</key>
  <string>${bundleId}</string>
  <key>CFBundleInfoDictionaryVersion</key>
  <string>6.0</string>
  <key>CFBundleName</key>
  <string>${appName}</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleShortVersionString</key>
  <string>0.0.0-dev</string>
  <key>CFBundleVersion</key>
  <string>0.0.0</string>
  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>${bundleId}</string>
      <key>CFBundleURLSchemes</key>
      <array>
        <string>${scheme}</string>
      </array>
    </dict>
  </array>
</dict>
</plist>
`;

const launcher = `#!/bin/sh
export TUTTI_ENV="\${TUTTI_ENV:-development}"
export NODE_ENV="\${NODE_ENV:-development}"
cd ${JSON.stringify(rootDir)}
exec ${JSON.stringify(electronPath)} ${JSON.stringify(appEntry)} "$@"
`;

async function writeBundle() {
  const currentLauncher = await readFile(launcherPath, "utf8").catch(() => "");
  const currentPlist = await readFile(
    join(appDir, "Contents/Info.plist"),
    "utf8"
  ).catch(() => "");
  if (currentLauncher === launcher && currentPlist === plist) {
    return;
  }

  await rm(appDir, { recursive: true, force: true });
  await mkdir(macOSDir, { recursive: true });
  await mkdir(resourcesDir, { recursive: true });
  await writeFile(join(appDir, "Contents/Info.plist"), plist);
  await writeFile(launcherPath, launcher);
  await chmod(launcherPath, 0o755);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `${command} failed`);
  }
}

await writeBundle();
run(
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister",
  ["-f", appDir]
);
run("/usr/bin/swift", [
  "-e",
  `import CoreServices
import Foundation
LSSetDefaultHandlerForURLScheme("${scheme}" as NSString, "${bundleId}" as NSString)`
]);

console.log(`[dev-gui] registered ${scheme} to ${appDir}`);
