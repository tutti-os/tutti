#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const schemaVersion = "tutti.desktop.changelog.v1";

function createEmptyChangelog() {
  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    entries: []
  };
}

function parseExistingChangelog(value) {
  if (!value.trim()) {
    return createEmptyChangelog();
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Existing changelog is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schemaVersion !== schemaVersion ||
    !Array.isArray(parsed.entries)
  ) {
    throw new Error(`Existing changelog must use schema ${schemaVersion}`);
  }

  return {
    schemaVersion,
    generatedAt:
      typeof parsed.generatedAt === "string"
        ? parsed.generatedAt
        : new Date().toISOString(),
    entries: parsed.entries
  };
}

function toChangelogEntry(summary) {
  return {
    tag: summary.tag,
    version: summary.version,
    channel: summary.channel,
    prerelease: Boolean(summary.prerelease),
    releasedAt: summary.generatedAt,
    gitSha: summary.targetCommit,
    compare: summary.compare,
    zh: summary.zh,
    en: summary.en
  };
}

function compareEntries(left, right) {
  return String(right.releasedAt ?? "").localeCompare(
    String(left.releasedAt ?? "")
  );
}

function upsertChangelogEntry(existing, summary) {
  const changelog =
    typeof existing === "string" ? parseExistingChangelog(existing) : existing;
  const entry = toChangelogEntry(summary);
  const entries = [
    entry,
    ...changelog.entries.filter(
      (candidate) =>
        candidate.tag !== entry.tag && candidate.version !== entry.version
    )
  ].sort(compareEntries);

  return {
    schemaVersion,
    generatedAt: new Date().toISOString(),
    entries
  };
}

async function readOptionalFile(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

async function main() {
  const [existingChangelogPath, summaryPath, outputChangelogPath] =
    process.argv.slice(2);
  if (!existingChangelogPath || !summaryPath || !outputChangelogPath) {
    throw new Error(
      "Usage: node apps/desktop/scripts/upsert-release-changelog.mjs <existing-changelog-json-path> <summary-json-path> <output-changelog-json-path>"
    );
  }

  const existing = await readOptionalFile(existingChangelogPath);
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const changelog = upsertChangelogEntry(existing, summary);
  await writeFile(
    outputChangelogPath,
    `${JSON.stringify(changelog, null, 2)}\n`,
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
  createEmptyChangelog,
  parseExistingChangelog,
  schemaVersion,
  toChangelogEntry,
  upsertChangelogEntry
};
