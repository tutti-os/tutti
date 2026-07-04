#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const SECTION_START = "<!-- tutti-desktop-release-summary:start -->";
const SECTION_END = "<!-- tutti-desktop-release-summary:end -->";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeManagedSection(body) {
  const managedSectionPattern = new RegExp(
    `\\n*${escapeRegex(SECTION_START)}[\\s\\S]*?${escapeRegex(SECTION_END)}\\n*`,
    "g"
  );

  return body.replace(managedSectionPattern, "\n").trimEnd();
}

function renderLocaleSummary(
  title,
  localeSummary,
  { includeQaFocus = true } = {}
) {
  const lines = [`### ${title}`, "", localeSummary.headline, ""];
  for (const section of localeSummary.sections ?? []) {
    lines.push(`#### ${section.title}`);
    for (const item of section.items ?? []) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  const qaFocus = localeSummary.qaFocus ?? [];
  if (includeQaFocus && qaFocus.length > 0) {
    lines.push(title === "中文" ? "#### QA 重点" : "#### QA Focus");
    for (const item of qaFocus) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return lines;
}

function renderReleaseSummarySection(summary) {
  return [
    SECTION_START,
    "## Release Summary",
    "",
    ...renderLocaleSummary("Highlights", summary.en, {
      includeQaFocus: false
    }),
    SECTION_END
  ].join("\n");
}

function buildUpdatedReleaseBody({ existingBody, summary }) {
  const cleanedBody = removeManagedSection(existingBody);
  return [renderReleaseSummarySection(summary), "", cleanedBody, ""]
    .join("\n")
    .trimStart();
}

async function main() {
  const [existingBodyPath, summaryPath, outputBodyPath] = process.argv.slice(2);
  if (!existingBodyPath || !summaryPath || !outputBodyPath) {
    throw new Error(
      "Usage: node apps/desktop/scripts/upsert-release-summary.mjs <existing-body-path> <summary-json-path> <output-body-path>"
    );
  }

  const existingBody = await readFile(existingBodyPath, "utf8");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  await writeFile(
    outputBodyPath,
    buildUpdatedReleaseBody({ existingBody, summary }),
    "utf8"
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

export {
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody,
  removeManagedSection,
  renderReleaseSummarySection
};
