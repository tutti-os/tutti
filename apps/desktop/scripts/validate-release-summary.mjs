#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const schemaVersion = "tutti.desktop.release.summary.v1";
const releaseTagPattern =
  /^v(?<version>(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?<channel>rc|beta)\.(?:0|[1-9]\d*))?)$/u;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function validateLocale(locale, label) {
  if (!locale || typeof locale !== "object" || Array.isArray(locale)) {
    throw new Error(`${label} must be an object`);
  }
  requireNonEmptyString(locale.headline, `${label}.headline`);
  if (!Array.isArray(locale.sections) || locale.sections.length === 0) {
    throw new Error(`${label}.sections must be a non-empty array`);
  }
  for (const [sectionIndex, section] of locale.sections.entries()) {
    requireNonEmptyString(
      section?.title,
      `${label}.sections[${sectionIndex}].title`
    );
    if (!Array.isArray(section?.items) || section.items.length === 0) {
      throw new Error(
        `${label}.sections[${sectionIndex}].items must be a non-empty array`
      );
    }
    for (const [itemIndex, item] of section.items.entries()) {
      requireNonEmptyString(
        item,
        `${label}.sections[${sectionIndex}].items[${itemIndex}]`
      );
    }
  }
  if (!Array.isArray(locale.qaFocus)) {
    throw new Error(`${label}.qaFocus must be an array`);
  }
  for (const [itemIndex, item] of locale.qaFocus.entries()) {
    requireNonEmptyString(item, `${label}.qaFocus[${itemIndex}]`);
  }
}

function validateReleaseSummary(summary, expected = {}) {
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) {
    throw new Error("release summary must be an object");
  }
  if (summary.schemaVersion !== schemaVersion) {
    throw new Error(
      `Unexpected release summary schema: ${summary.schemaVersion}`
    );
  }

  const tagMatch = releaseTagPattern.exec(summary.tag);
  if (!tagMatch?.groups) {
    throw new Error(`Unsupported release summary tag: ${summary.tag}`);
  }
  const derivedChannel = tagMatch.groups.channel ?? "stable";
  const derivedPrerelease = derivedChannel !== "stable";
  if (summary.version !== tagMatch.groups.version) {
    throw new Error("release summary version does not match its tag");
  }
  if (summary.channel !== derivedChannel) {
    throw new Error("release summary channel does not match its tag");
  }
  if (summary.prerelease !== derivedPrerelease) {
    throw new Error(
      "release summary prerelease flag does not match its channel"
    );
  }

  requireNonEmptyString(summary.targetCommit, "release summary targetCommit");
  requireNonEmptyString(summary.generatedAt, "release summary generatedAt");
  if (Number.isNaN(Date.parse(summary.generatedAt))) {
    throw new Error("release summary generatedAt must be an ISO date-time");
  }
  if (
    summary.summarySource !== "agnes" &&
    summary.summarySource !== "fallback"
  ) {
    throw new Error("release summary summarySource must be agnes or fallback");
  }
  if (
    !summary.compare ||
    typeof summary.compare !== "object" ||
    Array.isArray(summary.compare)
  ) {
    throw new Error("release summary compare must be an object");
  }
  if (
    summary.compare.from !== null &&
    typeof summary.compare.from !== "string"
  ) {
    throw new Error("release summary compare.from must be a string or null");
  }
  requireNonEmptyString(summary.compare.range, "release summary compare.range");
  requireNonEmptyString(summary.compare.to, "release summary compare.to");
  validateLocale(summary.zh, "release summary zh");
  validateLocale(summary.en, "release summary en");

  for (const [field, expectedValue] of Object.entries(expected)) {
    if (expectedValue && summary[field] !== expectedValue) {
      throw new Error(
        `release summary ${field} does not match the staged release`
      );
    }
  }
  return summary;
}

async function main() {
  const [summaryPath] = process.argv.slice(2);
  if (!summaryPath) {
    throw new Error("Usage: validate-release-summary.mjs <summary-json-path>");
  }
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  validateReleaseSummary(summary, {
    tag: process.env.RELEASE_TAG,
    channel: process.env.RELEASE_CHANNEL,
    targetCommit: process.env.RELEASE_TARGET
  });
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

export { schemaVersion, validateReleaseSummary };
