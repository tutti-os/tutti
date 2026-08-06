import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildMobileReleaseLatest,
  mobilePackageName,
  mobileReleaseLatestSchemaVersion
} from "./build-mobile-release-latest.mjs";

test("builds an Android latest pointer with immutable APK metadata", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tutti-mobile-release-")
  );
  const apkPath = path.join(directory, "app-release.apk");
  await writeFile(apkPath, "apk-bytes");

  const latest = await buildMobileReleaseLatest({
    apkPath,
    baseURL: "https://downloads.example.test/tutti-mobile-releases/",
    releasedAt: "2026-08-06T00:00:00.000Z",
    tag: "tutti-mobile-v0.1.1",
    versionCode: "42",
    versionName: "0.1.1"
  });

  assert.deepEqual(latest, {
    apkUrl:
      "https://downloads.example.test/tutti-mobile-releases/tutti-mobile-v0.1.1/app-release.apk",
    baseUrl: "https://downloads.example.test/tutti-mobile-releases",
    mandatory: false,
    packageName: mobilePackageName,
    releasedAt: "2026-08-06T00:00:00.000Z",
    schemaVersion: mobileReleaseLatestSchemaVersion,
    sha256: "1e10ba560383b17472b4cf72fef8f9e76c66815a3e6ae8c5a9b0c5e696b0bdf8",
    sizeBytes: 9,
    tag: "tutti-mobile-v0.1.1",
    versionCode: 42,
    versionName: "0.1.1"
  });

  assert.equal(await readFile(apkPath, "utf8"), "apk-bytes");
});

test("requires an HTTPS release base URL", async () => {
  await assert.rejects(
    () =>
      buildMobileReleaseLatest({
        apkPath: "/tmp/app-release.apk",
        baseURL: "http://downloads.example.test",
        releasedAt: "2026-08-06T00:00:00.000Z",
        tag: "tutti-mobile-v0.1.1",
        versionCode: 42,
        versionName: "0.1.1"
      }),
    /baseURL must use HTTPS/
  );
});
