import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const appDir = path.resolve(path.dirname(scriptPath), "..");
const packageScript = path.join(appDir, "scripts", "package-builtin.mjs");
const packageRoot = path.join(appDir, "build", "package");
const zipPath = path.resolve(
  appDir,
  "..",
  "generated",
  "trae-solo-bridge",
  "trae-solo-bridge-0.1.0.zip"
);

test("Trae Solo Bridge built-in package can be generated", async () => {
  await run(process.execPath, [packageScript]);
  await access(zipPath);
  const manifest = JSON.parse(
    await readFile(path.join(packageRoot, "tutti.app.json"), "utf8")
  );
  assert.equal(manifest.appId, "trae-solo-bridge");
  assert.equal(manifest.runtime.profile, "node-static");
  await access(path.join(packageRoot, "server.js"));
  await access(path.join(packageRoot, "devtools_send.js"));
});

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: appDir,
      env: process.env,
      stdio: "inherit"
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}`)
      );
    });
  });
}
