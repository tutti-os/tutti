#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { parseReleaseTag } from "./lib/releaseConfig.mjs";

const schemaVersion = "tutti.desktop.release.summary.v1";
const agnesEndpoint = "https://apihub.agnes-ai.com/v1/chat/completions";
const agnesModel = "agnes-2.0-flash";
const zhSectionTitles = ["功能变更", "体验优化", "问题修复", "发布与更新"];
const enSectionTitles = [
  "Feature Updates",
  "Experience Improvements",
  "Bug Fixes",
  "Release and Updates"
];

function parseArgs(argv) {
  const args = new Map();
  for (let index = 2; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) {
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      args.set(key.slice(2), "true");
      continue;
    }
    args.set(key.slice(2), next);
    index += 1;
  }
  return args;
}

function readOption(args, name, envName, fallback = "") {
  return (args.get(name) ?? process.env[envName] ?? fallback).trim();
}

function requireOption(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function normalizeVersion(tag) {
  return parseReleaseTag(tag) ?? tag.replace(/^v/u, "");
}

function isPrereleaseVersion(version) {
  return /-[0-9A-Za-z.-]+$/u.test(version);
}

function resolveChannel({ channel = "", version }) {
  if (channel === "stable" || channel === "rc" || channel === "beta") {
    return channel;
  }
  const prereleaseMatch = /^.+-(rc|beta)\.(0|[1-9]\d*)$/u.exec(version);
  if (prereleaseMatch) {
    return prereleaseMatch[1];
  }
  return isPrereleaseVersion(version) ? "rc" : "stable";
}

function runGit(args, fallback = "") {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return fallback;
  }
}

function listReleaseTags() {
  return runGit(["tag", "--list", "v*", "--sort=-version:refname"])
    .split("\n")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function parseStableCore(version) {
  const match = /^(?<core>\d+\.\d+\.\d+)(?:-(?:rc|beta)\.\d+)?$/u.exec(version);
  return match?.groups?.core ?? "";
}

function resolvePreviousTag({ channel, tag, version }) {
  const tags = listReleaseTags().filter((candidate) => candidate !== tag);
  if (channel === "stable") {
    return tags.find((candidate) => !isPrereleaseVersion(normalizeVersion(candidate))) ?? "";
  }

  const stableCore = parseStableCore(version);
  return (
    tags.find((candidate) => {
      const candidateVersion = normalizeVersion(candidate);
      return (
        candidateVersion.startsWith(`${stableCore}-${channel}.`) &&
        isPrereleaseVersion(candidateVersion)
      );
    }) ??
    tags.find((candidate) => !isPrereleaseVersion(normalizeVersion(candidate))) ??
    ""
  );
}

function resolveGitSha(target) {
  return runGit(["rev-parse", target], target);
}

function collectReleaseInput({ compareFrom, target }) {
  const range = compareFrom ? `${compareFrom}..${target}` : target;
  return {
    commits: runGit(
      [
        "log",
        "--no-merges",
        "--pretty=format:%h %s",
        compareFrom ? range : "-40"
      ],
      ""
    )
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(0, 80),
    diffStat: compareFrom
      ? runGit(["diff", "--stat", "--find-renames", range], "")
      : "",
    range
  };
}

function stripConventionalPrefix(message) {
  return message
    .replace(/^[0-9a-f]{7,}\s+/iu, "")
    .replace(/^(feat|fix|perf|refactor|docs|test|chore|ci)(\([^)]+\))?!?:\s*/iu, "")
    .trim();
}

function classifyCommit(message) {
  if (/^[0-9a-f]{7,}\s+fix(\(|:|!)/iu.test(message)) {
    return "问题修复";
  }
  if (/^[0-9a-f]{7,}\s+feat(\(|:|!)/iu.test(message)) {
    return "功能变更";
  }
  if (/^[0-9a-f]{7,}\s+(perf|refactor)(\(|:|!)/iu.test(message)) {
    return "体验优化";
  }
  if (/release|download|updat|installer|dmg|s3|github action|workflow/iu.test(message)) {
    return "发布与更新";
  }
  return "体验优化";
}

function toSentence(value) {
  const trimmed = value.trim().replace(/[。.]$/u, "");
  return trimmed ? `${trimmed}。` : "";
}

function buildFallbackSections(commits) {
  const grouped = new Map();
  for (const commit of commits) {
    const title = classifyCommit(commit);
    const item = toSentence(stripConventionalPrefix(commit));
    if (!item) {
      continue;
    }
    const items = grouped.get(title) ?? [];
    if (items.length < 4 && !items.includes(item)) {
      items.push(item);
    }
    grouped.set(title, items);
  }

  const sections = [...grouped.entries()]
    .map(([title, items]) => ({ title, items }))
    .filter((section) => section.items.length > 0)
    .slice(0, 4);

  return sections.length > 0
    ? sections
    : [{ title: "功能优化", items: ["整理本次桌面端发布内容。"] }];
}

function localizeSectionsToEnglish(sections) {
  const titleMap = new Map([
    ["功能变更", "Feature Updates"],
    ["体验优化", "Experience Improvements"],
    ["问题修复", "Bug Fixes"],
    ["发布与更新", "Release and Updates"]
  ]);
  return sections.map((section) => ({
    title: titleMap.get(section.title) ?? section.title,
    items: section.items.map((item) =>
      item.replace(/。$/u, ".").replace(/^整理本次桌面端发布内容/u, "Summarized this desktop release")
    )
  }));
}

function normalizeSectionTitle(title, language) {
  const value = String(title ?? "").trim();
  if (language === "en") {
    if (enSectionTitles.includes(value)) {
      return value;
    }
    if (/bug|fix|issue|crash|error|correct/i.test(value)) {
      return "Bug Fixes";
    }
    if (
      /release|update|download|install|installer|channel|stable|beta/i.test(value) ||
      /\brc\b/i.test(value)
    ) {
      return "Release and Updates";
    }
    if (/feature|new|support|add/i.test(value)) {
      return "Feature Updates";
    }
    return "Experience Improvements";
  }

  if (zhSectionTitles.includes(value)) {
    return value;
  }
  if (/修复|问题|错误|崩溃|异常|bug/i.test(value)) {
    return "问题修复";
  }
  if (/发布|更新|下载|安装|渠道|稳定版|正式版|预发布|RC|Beta/i.test(value)) {
    return "发布与更新";
  }
  if (/新增|新功能|支持|能力|功能/i.test(value)) {
    return "功能变更";
  }
  return "体验优化";
}

function buildFallbackSummary(input) {
  const sections = buildFallbackSections(input.commits);
  return {
    source: "fallback",
    zh: {
      headline: "本次版本整理了桌面端更新内容。",
      sections,
      qaFocus: ["验证安装包下载、自动更新检查和主要桌面端启动流程。"]
    },
    en: {
      headline: "This release summarizes the latest desktop changes.",
      sections: localizeSectionsToEnglish(sections),
      qaFocus: [
        "Verify installer download, update checks, and the main desktop startup flow."
      ]
    }
  };
}

function sanitizeSummary(candidate) {
  const fallback = buildFallbackSummary({ commits: [] });
  const normalizeLocale = (locale, fallbackLocale, language) => ({
    headline:
      typeof locale?.headline === "string" && locale.headline.trim()
        ? locale.headline.trim()
        : fallbackLocale.headline,
    sections: Array.isArray(locale?.sections)
      ? locale.sections
          .map((section) => ({
            title: normalizeSectionTitle(section?.title, language),
            items: Array.isArray(section?.items)
              ? section.items
                  .filter((item) => typeof item === "string" && item.trim())
                  .map((item) => item.trim())
                  .slice(0, 4)
              : []
          }))
          .filter((section) => section.items.length > 0)
          .slice(0, 4)
      : fallbackLocale.sections,
    qaFocus: Array.isArray(locale?.qaFocus)
      ? locale.qaFocus
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim())
          .slice(0, 3)
      : fallbackLocale.qaFocus
  });

  return {
    source: candidate?.source === "agnes" ? "agnes" : "fallback",
    zh: normalizeLocale(candidate?.zh, fallback.zh, "zh"),
    en: normalizeLocale(candidate?.en, fallback.en, "en")
  };
}

function extractJsonObject(value) {
  const start = value.indexOf("{");
  const end = value.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) {
    return null;
  }
  try {
    return JSON.parse(value.slice(start, end + 1));
  } catch {
    return null;
  }
}

async function buildAgnesSummary(input, apiKey) {
  const prompt = [
    "You summarize desktop app releases for end users and QA, not for engineers.",
    "Return only JSON with shape:",
    '{"zh":{"headline":"","sections":[{"title":"","items":[""]}],"qaFocus":[""]},"en":{"headline":"","sections":[{"title":"","items":[""]}],"qaFocus":[""]}}',
    "Use Chinese for zh and English for en. Do not invent changes beyond commits and diff stat.",
    "Write from user-visible impact first. Avoid implementation jargon unless it directly affects installation, updates, data safety, or QA.",
    "When a change is release infrastructure only, describe it as internal QA, packaging, download, or update validation work; do not claim regular users can access it unless the commits explicitly add user-facing UI or settings.",
    "For beta channel changes, say internal beta packages or development-branch validation. Do not describe beta as public early access unless the commits explicitly say it is exposed to users.",
    `For zh.sections[].title, use only these section titles: ${zhSectionTitles.join("、")}.`,
    `For en.sections[].title, use only these section titles: ${enSectionTitles.join(", ")}.`,
    "Do not use module or architecture headings such as Core Architecture, Backend, Database, IPC, AgentGUI, or Services.",
    "Translate internal refactors into plain outcomes, for example more reliable startup, clearer settings, smoother agent conversations, safer update flow, or better data migration.",
    "Keep each item short and concrete. Prefer 3 to 6 useful user-facing items total. Put technical-only changes into Release and Updates or omit them if they have no user/QA impact.",
    "",
    `Tag: ${input.tag}`,
    `Version: ${input.version}`,
    `Channel: ${input.channel}`,
    `Range: ${input.compare.range}`,
    "",
    "Commits:",
    input.commits.join("\n") || "(none)",
    "",
    "Diff stat:",
    input.diffStat || "(none)"
  ].join("\n");

  const response = await fetch(agnesEndpoint, {
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      model: agnesModel,
      temperature: 0.2
    }),
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json"
    },
    method: "POST"
  });
  if (!response.ok) {
    throw new Error(`Agnes returned ${response.status}`);
  }
  const data = await response.json();
  const content = data?.choices?.[0]?.message?.content;
  const parsed = typeof content === "string" ? extractJsonObject(content) : null;
  if (!parsed) {
    throw new Error("Agnes response did not contain JSON");
  }
  return sanitizeSummary({ ...parsed, source: "agnes" });
}

async function buildReleaseSummary(options) {
  const tag = requireOption(options.tag, "tag");
  const version = normalizeVersion(tag);
  const channel = resolveChannel({ channel: options.channel, version });
  const target = requireOption(options.target || "HEAD", "target");
  const targetCommit = resolveGitSha(target);
  const requestedCompareFrom = String(options.compareFrom ?? "").trim();
  const compareFrom =
    requestedCompareFrom || resolvePreviousTag({ channel, tag, version });
  const collected = collectReleaseInput({ compareFrom, target });
  const baseInput = {
    channel,
    commits: collected.commits,
    compare: {
      from: compareFrom || null,
      range: collected.range,
      to: target
    },
    diffStat: collected.diffStat,
    tag,
    targetCommit,
    version
  };

  let content = buildFallbackSummary(collected);
  if (options.apiKey) {
    try {
      content = await buildAgnesSummary(baseInput, options.apiKey);
    } catch (error) {
      content = {
        ...content,
        source: "fallback",
        warning: error instanceof Error ? error.message : String(error)
      };
    }
  }

  return {
    schemaVersion,
    tag,
    version,
    channel,
    prerelease: channel !== "stable",
    targetCommit,
    compare: baseInput.compare,
    generatedAt: new Date().toISOString(),
    summarySource: content.source,
    warning: content.warning,
    zh: content.zh,
    en: content.en
  };
}

async function main() {
  const args = parseArgs(process.argv);
  const outputPath = requireOption(
    readOption(args, "output", "SUMMARY_OUTPUT"),
    "output"
  );
  const inputPath = readOption(args, "input", "SUMMARY_INPUT");
  const input = inputPath ? JSON.parse(await readFile(inputPath, "utf8")) : {};
  const summary = await buildReleaseSummary({
    ...input,
    apiKey: readOption(args, "api-key", "AGNES_API_KEY"),
    channel: readOption(args, "channel", "RELEASE_CHANNEL", input.channel ?? ""),
    compareFrom: readOption(
      args,
      "compare-from",
      "RELEASE_COMPARE_FROM",
      input.compareFrom ?? ""
    ),
    tag: readOption(args, "tag", "RELEASE_TAG", input.tag ?? ""),
    target: readOption(args, "target", "RELEASE_TARGET", input.target ?? "HEAD")
  });

  await writeFile(outputPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
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
  buildFallbackReleaseSummary,
  buildReleaseSummary,
  classifyCommit,
  normalizeVersion,
  normalizeSectionTitle,
  resolveChannel,
  schemaVersion
};

function buildFallbackReleaseSummary(input) {
  return buildFallbackSummary(input);
}
