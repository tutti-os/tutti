import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
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
      "https://downloads.example.test/tutti-mobile-releases/tutti-mobile-v0.1.1/1e10ba560383b17472b4cf72fef8f9e76c66815a3e6ae8c5a9b0c5e696b0bdf8/app-release.apk",
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

test("rejects an empty Android package", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tutti-empty-mobile-release-")
  );
  const apkPath = path.join(directory, "app-release.apk");
  await writeFile(apkPath, "");

  await assert.rejects(
    () =>
      buildMobileReleaseLatest({
        apkPath,
        baseURL: "https://downloads.example.test",
        releasedAt: "2026-08-06T00:00:00.000Z",
        tag: "tutti-mobile-v0.1.1",
        versionCode: 42,
        versionName: "0.1.1"
      }),
    /APK size/
  );
});

test("content-addresses retries of the same version independently", async () => {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "tutti-mobile-release-retry-")
  );
  const firstAPK = path.join(directory, "first", "app-release.apk");
  const secondAPK = path.join(directory, "second", "app-release.apk");
  await mkdir(path.dirname(firstAPK), { recursive: true });
  await mkdir(path.dirname(secondAPK), { recursive: true });
  await writeFile(firstAPK, "first-build");
  await writeFile(secondAPK, "retry-with-new-version-code");
  const baseOptions = {
    baseURL: "https://downloads.example.test/releases",
    releasedAt: "2026-08-06T00:00:00.000Z",
    tag: "tutti-mobile-v0.1.1",
    versionName: "0.1.1"
  };

  const first = await buildMobileReleaseLatest({
    ...baseOptions,
    apkPath: firstAPK,
    versionCode: 42
  });
  const retry = await buildMobileReleaseLatest({
    ...baseOptions,
    apkPath: secondAPK,
    versionCode: 43
  });

  assert.notEqual(first.sha256, retry.sha256);
  assert.match(first.apkUrl, new RegExp(`/${first.sha256}/app-release\\.apk$`));
  assert.match(retry.apkUrl, new RegExp(`/${retry.sha256}/app-release\\.apk$`));
});

test("serializes pointer publication and protects immutable assets", async () => {
  const workflowPath = new URL(
    "../../.github/workflows/android-build.yml",
    import.meta.url
  );
  const workflow = await readFile(workflowPath, "utf8");

  assert.match(workflow, /mobile-android-release-publish/);
  assert.match(
    workflow,
    /cancel-in-progress: \$\{\{ !inputs\.publish_android \}\}/
  );
  assert.match(workflow, /preflight_immutable\(\)/);
  assert.match(workflow, /upload_immutable\(\)/);
  assert.match(
    workflow,
    /Refusing to overwrite immutable Android release asset/
  );
  assert.ok(
    workflow.indexOf("checksum_needs_upload=false") <
      workflow.indexOf('if [[ "${apk_needs_upload}" == true ]]'),
    "both immutable assets must be preflighted before either is uploaded"
  );
  assert.ok(
    workflow.lastIndexOf('"${remote_dir}/app-release.apk"') <
      workflow.indexOf('mobile-release-latest.json "${pointer_path}"'),
    "the immutable APK must be published before latest.json"
  );
});
