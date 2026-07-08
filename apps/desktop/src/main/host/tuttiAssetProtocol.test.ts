import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { resolveTuttiAssetProtocolFilePath } from "./tuttiAssetProtocolResolver.ts";

test("tutti asset protocol resolves development source assets", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-dev-"));
  const sourcePath = join(
    appPath,
    "src",
    "renderer",
    "src",
    "assets",
    "workspace-canvas",
    "dock",
    "default",
    "codex.png"
  );
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://agent/codex.png",
        appPath
      ),
      sourcePath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves packaged renderer assets", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-packaged-"));
  const builtAssetPath = join(
    appPath,
    "out",
    "renderer",
    "assets",
    "claude-rounded-abc123.png"
  );
  mkdirSync(dirname(builtAssetPath), { recursive: true });
  writeFileSync(builtAssetPath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://agent/claudecode.png",
        appPath
      ),
      builtAssetPath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves packaged codex rounded asset", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-codex-"));
  const builtAssetPath = join(
    appPath,
    "out",
    "renderer",
    "assets",
    "codex-rounded-abc123.png"
  );
  mkdirSync(dirname(builtAssetPath), { recursive: true });
  writeFileSync(builtAssetPath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://agent/codex.png",
        appPath
      ),
      builtAssetPath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves issue default asset route", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-issue-"));
  const sourcePath = join(
    appPath,
    "src",
    "renderer",
    "src",
    "assets",
    "workspace-canvas",
    "dock",
    "default",
    "issue.png"
  );
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://issue/default.png",
        appPath
      ),
      sourcePath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves file default asset route", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-file-"));
  const sourcePath = join(
    appPath,
    "src",
    "renderer",
    "src",
    "assets",
    "workspace-canvas",
    "dock",
    "default",
    "apps",
    "document.png"
  );
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://file/default.png",
        appPath
      ),
      sourcePath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves packaged file default asset", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-file-packaged-"));
  const builtAssetPath = join(
    appPath,
    "out",
    "renderer",
    "assets",
    "document-abc123.png"
  );
  mkdirSync(dirname(builtAssetPath), { recursive: true });
  writeFileSync(builtAssetPath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://file/default.png",
        appPath
      ),
      builtAssetPath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves folder default asset route", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-folder-"));
  const sourcePath = join(
    appPath,
    "src",
    "renderer",
    "src",
    "assets",
    "workspace-canvas",
    "dock",
    "default",
    "files.png"
  );
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://folder/default.png",
        appPath
      ),
      sourcePath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves packaged folder default asset", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-folder-packaged-"));
  const builtAssetPath = join(
    appPath,
    "out",
    "renderer",
    "assets",
    "files-abc123.png"
  );
  mkdirSync(dirname(builtAssetPath), { recursive: true });
  writeFileSync(builtAssetPath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://folder/default.png",
        appPath
      ),
      builtAssetPath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol rejects unknown asset routes", () => {
  assert.equal(
    resolveTuttiAssetProtocolFilePath(
      "tutti-asset://agent/unknown.png",
      "/tmp/missing"
    ),
    null
  );
  assert.equal(
    resolveTuttiAssetProtocolFilePath(
      "https://agent/codex.png",
      "/tmp/missing"
    ),
    null
  );
});
