#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  buildReleaseApprovalDigest,
  validateReleaseCandidateManifest
} from "./lib/releaseCandidate.mjs";

async function main() {
  const [
    manifestPath,
    checksumsPath,
    generatedSummaryPath,
    approvedSummaryPath
  ] = process.argv.slice(2);
  if (!manifestPath || !checksumsPath || !generatedSummaryPath) {
    throw new Error(
      "Usage: verify-release-candidate.mjs <manifest> <checksums> <generated-summary> [approved-summary]"
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const checksums = await readFile(checksumsPath, "utf8");
  const generatedSummary = await readFile(generatedSummaryPath, "utf8");
  validateReleaseCandidateManifest(manifest, {
    tag: process.env.RELEASE_TAG,
    targetCommit: process.env.RELEASE_TARGET,
    checksums,
    generatedSummary
  });
  if (!approvedSummaryPath) {
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  const approvedSummary = JSON.parse(
    await readFile(approvedSummaryPath, "utf8")
  );
  process.stdout.write(
    `${JSON.stringify({
      ...manifest,
      approvalDigest: buildReleaseApprovalDigest(manifest, approvedSummary)
    })}\n`
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
