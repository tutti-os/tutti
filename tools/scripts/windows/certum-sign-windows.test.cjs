const assert = require("node:assert/strict");
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const test = require("node:test");
const { findExecutables } = require("./certum-sign-windows.cjs");

test("findExecutables recursively returns only Windows executables", () => {
  const root = mkdtempSync(join(tmpdir(), "tutti-certum-files-"));
  try {
    mkdirSync(join(root, "resources", "bin"), { recursive: true });
    writeFileSync(join(root, "Tutti.exe"), "main");
    writeFileSync(join(root, "resources", "bin", "runtime.EXE"), "runtime");
    writeFileSync(join(root, "resources", "bin", "library.dll"), "library");
    assert.deepEqual(
      findExecutables(root).map((path) => path.slice(root.length + 1)),
      ["resources/bin/runtime.EXE", "Tutti.exe"]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Electron Builder Certum config uses the custom SHA-256 signer", () => {
  process.env.TSH_CERTUM_ELECTRON_BUILDER_SIGNER = "/tmp/certum-signer.cjs";
  process.env.TSH_WINDOWS_EXPECTED_PUBLISHER = "Expected Publisher";
  const config = require("../../../apps/desktop/scripts/electron-builder-certum-options.cjs");
  assert.deepEqual(config.win.signtoolOptions.signingHashAlgorithms, [
    "sha256"
  ]);
  assert.equal(config.win.signtoolOptions.sign, "/tmp/certum-signer.cjs");
  assert.equal(config.win.signtoolOptions.publisherName, "Expected Publisher");
});
