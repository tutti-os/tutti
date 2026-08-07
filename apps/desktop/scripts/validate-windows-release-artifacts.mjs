#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

function parseScalar(rawValue) {
  const value = rawValue.trim();
  if (value.startsWith('"')) {
    return JSON.parse(value);
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

function parseUpdaterMetadata(source) {
  const metadata = { files: [] };
  let inFiles = false;
  let currentFile;

  for (const line of source.split(/\r?\n/u)) {
    const topLevel = /^(\S[^:]*):(?:\s*(.*))?$/u.exec(line);
    if (topLevel) {
      inFiles = topLevel[1] === "files";
      currentFile = undefined;
      if (["path", "sha512", "version"].includes(topLevel[1])) {
        metadata[topLevel[1]] = parseScalar(topLevel[2] ?? "");
      }
      continue;
    }

    if (!inFiles) continue;
    const fileStart = /^\s+-\s+url:\s*(.+)$/u.exec(line);
    if (fileStart) {
      currentFile = { url: parseScalar(fileStart[1]) };
      metadata.files.push(currentFile);
      continue;
    }
    const fileSha = /^\s+sha512:\s*(.+)$/u.exec(line);
    if (fileSha && currentFile) {
      currentFile.sha512 = parseScalar(fileSha[1]);
    }
  }

  return metadata;
}

async function sha512(filePath) {
  const hash = createHash("sha512");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("base64");
}

async function validateWindowsReleaseArtifacts(directory, channel, releaseTag) {
  if (!new Set(["stable", "rc", "beta"]).has(channel)) {
    throw new Error(`Unsupported Windows release channel: ${channel}`);
  }
  const versionMatch =
    /^v(?<version>\d+\.\d+\.\d+(?:-(?:rc|beta)\.\d+)?)$/u.exec(releaseTag);
  if (!versionMatch?.groups) {
    throw new Error(`Unsupported Windows release tag: ${releaseTag}`);
  }

  const names = await readdir(directory);
  const installers = names.filter((name) => name.endsWith("-win-x64.exe"));
  if (installers.length !== 1) {
    throw new Error(
      `Expected exactly one Windows x64 installer, found ${installers.length}`
    );
  }
  const installerName = installers[0];
  const blockmapName = `${installerName}.blockmap`;
  if (!names.includes(blockmapName)) {
    throw new Error(`Missing Windows blockmap: ${blockmapName}`);
  }

  const metadataName = channel === "stable" ? "latest.yml" : `${channel}.yml`;
  if (!names.includes(metadataName)) {
    throw new Error(`Missing Windows updater metadata: ${metadataName}`);
  }
  const metadata = parseUpdaterMetadata(
    await readFile(path.join(directory, metadataName), "utf8")
  );
  const expectedVersion = versionMatch.groups.version;
  if (metadata.version !== expectedVersion) {
    throw new Error(
      `Windows updater version mismatch: expected ${expectedVersion}, found ${metadata.version}`
    );
  }
  if (metadata.path !== installerName) {
    throw new Error(
      `Windows updater path mismatch: expected ${installerName}, found ${metadata.path}`
    );
  }

  const installerSha512 = await sha512(path.join(directory, installerName));
  if (metadata.sha512 !== installerSha512) {
    throw new Error(
      "Windows updater top-level SHA-512 does not match installer"
    );
  }
  if (metadata.files.length !== 1) {
    throw new Error(
      `Expected exactly one Windows updater file entry, found ${metadata.files.length}`
    );
  }
  const [file] = metadata.files;
  if (file.url !== installerName) {
    throw new Error(
      `Windows updater file URL mismatch: expected ${installerName}, found ${file.url}`
    );
  }
  if (file.sha512 !== installerSha512) {
    throw new Error("Windows updater file SHA-512 does not match installer");
  }

  return {
    blockmapName,
    installerName,
    metadataName,
    version: expectedVersion
  };
}

async function main() {
  const [directory, channel, releaseTag] = process.argv.slice(2);
  if (!directory || !channel || !releaseTag) {
    throw new Error(
      "Usage: validate-windows-release-artifacts.mjs <directory> <stable|rc|beta> <release-tag>"
    );
  }
  await validateWindowsReleaseArtifacts(directory, channel, releaseTag);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`
    );
    process.exit(1);
  });
}

export { parseUpdaterMetadata, validateWindowsReleaseArtifacts };
