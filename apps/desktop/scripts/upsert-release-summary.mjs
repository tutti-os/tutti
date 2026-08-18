#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { buildLimitedGithubReleaseBody } from "./lib/githubReleaseBody.mjs";

const SECTION_START = "<!-- tutti-desktop-release-summary:start -->";
const SECTION_END = "<!-- tutti-desktop-release-summary:end -->";
const REVIEW_START = "<!-- tutti-desktop-release-review:start -->";
const REVIEW_END = "<!-- tutti-desktop-release-review:end -->";
const SUGGESTION_START = "<!-- tutti-desktop-release-suggestion:start -->";
const SUGGESTION_END = "<!-- tutti-desktop-release-suggestion:end -->";

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sectionPattern(start, end) {
  return new RegExp(
    `\\n*${escapeRegex(start)}[\\s\\S]*?${escapeRegex(end)}\\n*`,
    "g"
  );
}

function removeSection(body, start, end) {
  return body.replace(sectionPattern(start, end), "\n").trimEnd();
}

function extractSection(body, start, end) {
  const match = body.match(sectionPattern(start, end));
  return match?.[0]?.trim() ?? "";
}

function renderLocaleSummary(title, localeSummary) {
  const lines = [`### ${title}`, "", localeSummary.headline, ""];
  for (const section of localeSummary.sections ?? []) {
    lines.push(`#### ${section.title}`);
    for (const item of section.items ?? []) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }
  return lines;
}

function renderReviewSection(summary) {
  return [
    REVIEW_START,
    "## Release Notes",
    "",
    ...renderLocaleSummary("中文", summary.zh),
    ...renderLocaleSummary("English", summary.en),
    REVIEW_END
  ].join("\n");
}

function renderSuggestionSection(summary) {
  return [
    SUGGESTION_START,
    "<details>",
    "<summary>Current generated suggestions (review only)</summary>",
    "",
    ...renderLocaleSummary("中文建议", summary.zh),
    ...renderLocaleSummary("English suggestions", summary.en),
    "</details>",
    SUGGESTION_END
  ].join("\n");
}

function removeManagedSection(body) {
  return removeSection(body, SECTION_START, SECTION_END);
}

function renderReleaseSummarySection(summary) {
  return renderReviewSection(summary);
}

function buildUpdatedReleaseBody({ existingBody, summary }) {
  const existingReview = extractSection(existingBody, REVIEW_START, REVIEW_END);
  let cleanedBody = removeManagedSection(existingBody);
  cleanedBody = removeSection(cleanedBody, REVIEW_START, REVIEW_END);
  cleanedBody = removeSection(cleanedBody, SUGGESTION_START, SUGGESTION_END);
  return buildLimitedGithubReleaseBody({
    existingBody: cleanedBody,
    leadingSections: [
      existingReview || renderReviewSection(summary),
      renderSuggestionSection(summary)
    ]
  });
}

function buildPublishedReleaseBody(body) {
  return removeSection(body, SUGGESTION_START, SUGGESTION_END);
}

function parseLocaleSection(sectionBody, title, nextTitle = null) {
  const start = sectionBody.indexOf(`### ${title}`);
  if (start < 0) throw new Error(`Missing review locale: ${title}`);
  const contentStart = start + `### ${title}`.length;
  const next = nextTitle
    ? sectionBody.indexOf(`### ${nextTitle}`, contentStart)
    : sectionBody.length;
  const lines = sectionBody
    .slice(contentStart, next < 0 ? sectionBody.length : next)
    .split("\n")
    .map((line) => line.trim());
  const headline = lines.find((line) => line && !line.startsWith("#"));
  if (!headline) throw new Error(`${title} review headline is required`);
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith("#### ")) {
      current = { title: line.slice(5).trim(), items: [] };
      sections.push(current);
    } else if (line.startsWith("- ") && current) {
      current.items.push(line.slice(2).trim());
    }
  }
  const validSections = sections.filter(
    (section) => section.title && section.items.length > 0
  );
  if (validSections.length === 0) {
    throw new Error(`${title} review must contain at least one section`);
  }
  return { headline, sections: validSections, qaFocus: [] };
}

function buildApprovedReleaseSummary({ body, generatedSummary, reviewedAt }) {
  const review = extractSection(body, REVIEW_START, REVIEW_END);
  if (!review) throw new Error("Release review section is missing");
  return {
    ...generatedSummary,
    generatedAt: reviewedAt ?? generatedSummary.generatedAt,
    summarySource: "human-reviewed",
    warning: undefined,
    zh: parseLocaleSection(review, "中文", "English"),
    en: parseLocaleSection(review, "English")
  };
}

async function main() {
  const [existingBodyPath, summaryPath, outputBodyPath] = process.argv.slice(2);
  if (!existingBodyPath || !summaryPath || !outputBodyPath) {
    throw new Error(
      "Usage: upsert-release-summary.mjs <existing-body> <summary-json> <output-body>"
    );
  }
  const existingBody = await readFile(existingBodyPath, "utf8");
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  const updated = buildUpdatedReleaseBody({ existingBody, summary });
  await writeFile(
    outputBodyPath,
    process.env.RELEASE_SUMMARY_MODE === "published"
      ? buildPublishedReleaseBody(updated)
      : updated,
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
  REVIEW_END,
  REVIEW_START,
  SECTION_END,
  SECTION_START,
  SUGGESTION_END,
  SUGGESTION_START,
  buildApprovedReleaseSummary,
  buildPublishedReleaseBody,
  buildUpdatedReleaseBody,
  removeManagedSection,
  renderReleaseSummarySection
};
