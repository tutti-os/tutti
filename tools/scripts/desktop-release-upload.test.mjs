import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  resolveUploadUrl,
  uploadReleaseAssets
} from "../../apps/desktop/scripts/upload-github-release-assets.mjs";

test("release asset upload uses the REST upload URL returned for the release", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-upload-"));
  const releasePath = path.join(dir, "release.json");
  const assetsDirectory = path.join(dir, "assets");
  await mkdir(assetsDirectory);
  await writeFile(
    releasePath,
    JSON.stringify({
      id: 42,
      upload_url:
        "https://uploads.github.test/repos/tutti-os/tutti/releases/42/assets{?name,label}"
    })
  );
  await writeFile(path.join(assetsDirectory, "b file.zip"), "second");
  await writeFile(path.join(assetsDirectory, "a.dmg"), "first");

  const requests = [];
  const fetchImpl = async (url, init) => {
    const chunks = [];
    for await (const chunk of init.body) chunks.push(chunk);
    requests.push({
      url: String(url),
      method: init.method,
      headers: init.headers,
      body: Buffer.concat(chunks).toString("utf8")
    });
    return new Response(null, { status: 201 });
  };

  try {
    const result = await uploadReleaseAssets({
      releasePath,
      assetsDirectory,
      token: "test-token",
      fetchImpl
    });

    assert.deepEqual(result, {
      releaseId: "42",
      assetNames: ["a.dmg", "b file.zip"]
    });
    assert.deepEqual(
      requests.map(({ url, body }) => ({ url, body })),
      [
        {
          url: "https://uploads.github.test/repos/tutti-os/tutti/releases/42/assets?name=a.dmg",
          body: "first"
        },
        {
          url: "https://uploads.github.test/repos/tutti-os/tutti/releases/42/assets?name=b+file.zip",
          body: "second"
        }
      ]
    );
    for (const request of requests) {
      assert.equal(request.method, "POST");
      assert.equal(request.headers.Authorization, "Bearer test-token");
      assert.equal(request.headers["Content-Type"], "application/octet-stream");
      assert.equal(
        request.headers["Content-Length"],
        String(request.body.length)
      );
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("release asset upload reports the release id and failed asset", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-upload-"));
  const releasePath = path.join(dir, "release.json");
  await writeFile(
    releasePath,
    JSON.stringify({
      id: 99,
      upload_url:
        "https://uploads.github.test/repos/tutti-os/tutti/releases/99/assets{?name,label}"
    })
  );
  await writeFile(path.join(dir, "broken.zip"), "payload");

  try {
    await assert.rejects(
      uploadReleaseAssets({
        releasePath,
        assetsDirectory: dir,
        token: "test-token",
        fetchImpl: async () => new Response("upstream failure", { status: 502 })
      }),
      /Failed to upload broken\.zip to GitHub release 99: 502 upstream failure/
    );
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("release upload URL preserves the endpoint and encodes the asset name", () => {
  assert.equal(
    resolveUploadUrl(
      "https://uploads.github.com/releases/7/assets{?name,label}",
      "Tutti Setup.exe"
    ).href,
    "https://uploads.github.com/releases/7/assets?name=Tutti+Setup.exe"
  );
});
