#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  createReleaseCandidateManifest,
  validateReleaseCandidateManifest
} from "./lib/releaseCandidate.mjs";

async function main() {
  const [checksumsPath, summaryPath, outputPath] = process.argv.slice(2);
  if (!checksumsPath || !summaryPath || !outputPath) {
    throw new Error(
      "Usage: build-release-candidate-manifest.mjs <checksums> <generated-summary> <output>"
    );
  }
  const checksums = await readFile(checksumsPath, "utf8");
  const generatedSummary = await readFile(summaryPath, "utf8");
  const manifest = createReleaseCandidateManifest({
    candidateId: process.env.RELEASE_CANDIDATE_ID,
    tag: process.env.RELEASE_TAG,
    version: process.env.RELEASE_VERSION,
    targetCommit: process.env.RELEASE_TARGET,
    sourceRef: process.env.RELEASE_SOURCE_REF,
    createdAt: process.env.RELEASE_CREATED_AT ?? new Date().toISOString(),
    workflowRunUrl: process.env.RELEASE_RUN_URL,
    checksums,
    generatedSummary
  });
  validateReleaseCandidateManifest(manifest, { checksums, generatedSummary });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
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
