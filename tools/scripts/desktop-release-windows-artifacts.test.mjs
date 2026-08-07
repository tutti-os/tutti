import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateWindowsReleaseArtifacts } from "../../apps/desktop/scripts/validate-windows-release-artifacts.mjs";

async function createArtifacts({
  channel = "stable",
  metadataSha,
  metadataVersion = "1.2.3",
  metadataUrl = "Tutti-1.2.3-win-x64.exe"
} = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), "tutti-win-release-"));
  const installerName = "Tutti-1.2.3-win-x64.exe";
  const installer = Buffer.from("test Windows installer");
  const sha = createHash("sha512").update(installer).digest("base64");
  const metadataName = channel === "stable" ? "latest.yml" : `${channel}.yml`;
  await writeFile(path.join(directory, installerName), installer);
  await writeFile(
    path.join(directory, `${installerName}.blockmap`),
    "blockmap"
  );
  await writeFile(
    path.join(directory, metadataName),
    [
      `version: ${metadataVersion}`,
      "files:",
      `  - url: ${metadataUrl}`,
      `    sha512: ${metadataSha ?? sha}`,
      "    size: 22",
      `path: ${metadataUrl}`,
      `sha512: ${metadataSha ?? sha}`,
      "releaseDate: '2026-08-07T00:00:00.000Z'",
      ""
    ].join("\n")
  );
  return { directory, installerName, metadataName };
}

test("validates stable Windows installer, blockmap, and updater metadata", async () => {
  const fixture = await createArtifacts();
  try {
    assert.deepEqual(
      await validateWindowsReleaseArtifacts(
        fixture.directory,
        "stable",
        "v1.2.3"
      ),
      {
        blockmapName: `${fixture.installerName}.blockmap`,
        installerName: fixture.installerName,
        metadataName: fixture.metadataName,
        version: "1.2.3"
      }
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("accepts RC channel metadata with the matching prerelease version", async () => {
  const fixture = await createArtifacts({
    channel: "rc",
    metadataVersion: "1.2.3-rc.4"
  });
  try {
    await validateWindowsReleaseArtifacts(
      fixture.directory,
      "rc",
      "v1.2.3-rc.4"
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("rejects updater metadata for a different release version", async () => {
  const fixture = await createArtifacts({ metadataVersion: "1.2.2" });
  try {
    await assert.rejects(
      validateWindowsReleaseArtifacts(fixture.directory, "stable", "v1.2.3"),
      /version mismatch/
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("rejects updater metadata whose installer digest is stale", async () => {
  const fixture = await createArtifacts({ metadataSha: "stale-sha512" });
  try {
    await assert.rejects(
      validateWindowsReleaseArtifacts(fixture.directory, "stable", "v1.2.3"),
      /SHA-512 does not match installer/
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});

test("rejects updater metadata that points at another installer", async () => {
  const fixture = await createArtifacts({
    metadataUrl: "Tutti-1.2.2-win-x64.exe"
  });
  try {
    await assert.rejects(
      validateWindowsReleaseArtifacts(fixture.directory, "stable", "v1.2.3"),
      /path mismatch/
    );
  } finally {
    await rm(fixture.directory, { force: true, recursive: true });
  }
});
