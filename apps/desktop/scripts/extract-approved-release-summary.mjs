#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildApprovedReleaseSummary } from "./upsert-release-summary.mjs";
import { validateReleaseSummary } from "./validate-release-summary.mjs";

async function main() {
  const [bodyPath, generatedSummaryPath, outputPath] = process.argv.slice(2);
  if (!bodyPath || !generatedSummaryPath || !outputPath) {
    throw new Error(
      "Usage: extract-approved-release-summary.mjs <release-body> <generated-summary> <output>"
    );
  }
  const body = await readFile(bodyPath, "utf8");
  const generatedSummary = JSON.parse(
    await readFile(generatedSummaryPath, "utf8")
  );
  const approved = buildApprovedReleaseSummary({ body, generatedSummary });
  validateReleaseSummary(approved, {
    tag: process.env.RELEASE_TAG,
    channel: process.env.RELEASE_CHANNEL,
    targetCommit: process.env.RELEASE_TARGET
  });
  await writeFile(outputPath, `${JSON.stringify(approved, null, 2)}\n`, "utf8");
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
