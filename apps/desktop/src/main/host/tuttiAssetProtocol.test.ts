import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { tuttiAssetProtocolAssets } from "./tuttiAssetProtocolAssets.ts";
import { resolveTuttiAssetProtocolFilePath } from "./tuttiAssetProtocolResolver.ts";
import { createTuttiAssetProtocolResponse } from "./tuttiAssetProtocolResponse.ts";

test("tutti asset protocol resolves development source assets", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-dev-"));
  const route = "agent/codex.png";
  const sourcePath = join(appPath, tuttiAssetProtocolAssets[route]);
  mkdirSync(dirname(sourcePath), { recursive: true });
  writeFileSync(sourcePath, "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(`tutti-asset://${route}`, appPath),
      sourcePath
    );
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol resolves every packaged asset by exact route", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-packaged-"));

  try {
    for (const route of Object.keys(tuttiAssetProtocolAssets)) {
      const builtAssetPath = join(
        appPath,
        "out",
        "renderer",
        "assets",
        "tutti-asset",
        route
      );
      mkdirSync(dirname(builtAssetPath), { recursive: true });
      writeFileSync(builtAssetPath, "");

      assert.equal(
        resolveTuttiAssetProtocolFilePath(`tutti-asset://${route}`, appPath),
        builtAssetPath
      );
    }
  } finally {
    rmSync(appPath, { force: true, recursive: true });
  }
});

test("tutti asset protocol ignores similarly prefixed renderer assets", () => {
  const appPath = mkdtempSync(join(tmpdir(), "tutti-asset-collision-"));
  const builtAssetsDirectory = join(appPath, "out", "renderer", "assets");
  mkdirSync(builtAssetsDirectory, { recursive: true });
  writeFileSync(join(builtAssetsDirectory, "tutti-00000000.png"), "");
  writeFileSync(join(builtAssetsDirectory, "tutti-vinyl-00000000.png"), "");

  try {
    assert.equal(
      resolveTuttiAssetProtocolFilePath(
        "tutti-asset://agent/tutti.png",
        appPath
      ),
      null
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

test("tutti asset protocol responses allow anonymous canvas image loads", async () => {
  const response = createTuttiAssetProtocolResponse(
    new Response("image", {
      headers: {
        "Content-Type": "image/png",
        "X-Asset-Header": "preserved"
      }
    })
  );

  assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*");
  assert.equal(response.headers.get("Content-Type"), "image/png");
  assert.equal(response.headers.get("X-Asset-Header"), "preserved");
  assert.equal(await response.text(), "image");
});
