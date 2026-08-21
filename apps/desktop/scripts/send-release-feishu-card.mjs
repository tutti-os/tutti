#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { RELEASE_REPO_NAME, RELEASE_REPO_OWNER } from "./lib/releaseConfig.mjs";

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

function requireOption(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function formatBuiltAt() {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "Asia/Shanghai"
  }).format(new Date());
}

function resolveDisplayValue(value, fallback = "unknown") {
  return value || fallback;
}

function resolveReleaseKind(tag, publicationStatus = "published") {
  if (/-rc\.(0|[1-9]\d*)$/i.test(tag)) {
    return publicationStatus === "candidate"
      ? "Draft release candidate prerelease"
      : "Release candidate prerelease";
  }
  if (/-beta\.(0|[1-9]\d*)$/i.test(tag)) {
    return publicationStatus === "candidate"
      ? "Draft beta prerelease"
      : "Beta prerelease";
  }
  return publicationStatus === "candidate"
    ? "Stable candidate"
    : "Stable latest release";
}

function resolveIntroText(tag, publicationStatus = "published") {
  if (publicationStatus === "candidate") {
    return `**${tag}** 候选版本已构建完成，请体验安装包并确认更新说明；当前尚未向用户开放更新。`;
  }
  if (/-rc\.(0|[1-9]\d*)$/i.test(tag)) {
    return `**${tag}** 已构建并同步到 RC 预览通道，可从下方入口下载安装包。`;
  }
  if (/-beta\.(0|[1-9]\d*)$/i.test(tag)) {
    return `**${tag}** 已构建并同步到 Beta 预览通道，可从下方入口下载安装包。`;
  }
  return `**${tag}** 已构建并发布为 GitHub Release，可从下方入口下载安装包。`;
}

function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, "");
}

function resolveReleaseAssetBaseUrl({
  bucket = "",
  explicitBaseUrl = "",
  prefix = ""
}) {
  if (explicitBaseUrl) {
    return normalizeBaseUrl(explicitBaseUrl);
  }

  if (!bucket || !prefix) {
    return "";
  }

  return `https://${bucket}.s3-accelerate.amazonaws.com/${prefix.replace(/^\/+|\/+$/g, "")}`;
}

function resolveGithubToken() {
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";
  if (envToken) {
    return envToken;
  }

  try {
    return execFileSync("gh", ["auth", "token"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

async function loadRelease(repository, tag, githubToken) {
  const headers = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28"
  };
  if (githubToken) {
    headers.authorization = `Bearer ${githubToken}`;
  }

  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers
    }
  );
  if (response.ok) {
    return response.json();
  }
  if (response.status !== 404) {
    throw new Error(
      `Unable to load release ${tag}: GitHub API returned ${response.status}`
    );
  }

  // GitHub's release-by-tag endpoint does not return draft releases. The
  // authenticated releases listing does, so fall back to it for draft-only,
  // release-candidate, and beta notification paths.
  for (let page = 1; ; page += 1) {
    const releasesResponse = await fetch(
      `https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`,
      {
        headers
      }
    );
    if (!releasesResponse.ok) {
      throw new Error(
        `Unable to load release ${tag}: GitHub API returned ${releasesResponse.status}`
      );
    }

    const releases = await releasesResponse.json();
    const release = releases.find((candidate) => candidate.tag_name === tag);
    if (release) {
      return release;
    }
    if (releases.length < 100) {
      break;
    }
  }

  throw new Error(`Unable to load release ${tag}: release was not found`);
}

function findPreferredAssetName(assetNames, pattern) {
  const matchingAssetNames = assetNames.filter((candidate) => {
    pattern.lastIndex = 0;
    return pattern.test(candidate);
  });
  return (
    matchingAssetNames.find((candidate) =>
      /-mac-universal\.dmg$/i.test(candidate)
    ) ?? matchingAssetNames[0]
  );
}

function findAssetUrl(
  release,
  pattern,
  releaseAssetBaseUrl = "",
  releaseAssetPath = ""
) {
  const assets = Array.isArray(release?.assets) ? release.assets : [];
  const assetName = findPreferredAssetName(
    assets.map((candidate) => candidate.name ?? ""),
    pattern
  );
  const asset = assets.find((candidate) => candidate.name === assetName);
  if (!asset?.browser_download_url) {
    return "";
  }

  if (releaseAssetBaseUrl) {
    const assetPath = releaseAssetPath || release.tag_name || "";
    if (!assetPath) {
      throw new Error(
        "Release tag name is missing from the GitHub release payload"
      );
    }

    const normalizedAssetPath = assetPath
      .split("/")
      .filter(Boolean)
      .map(encodeURIComponent)
      .join("/");
    return `${normalizeBaseUrl(releaseAssetBaseUrl)}/${normalizedAssetPath}/${encodeURIComponent(asset.name)}`;
  }

  return asset.browser_download_url;
}

async function listAssetNames(assetDirectory) {
  if (!assetDirectory) {
    return [];
  }

  return readdir(assetDirectory);
}

function resolveMirroredAssetUrl(
  assetNames,
  pattern,
  releaseAssetBaseUrl,
  assetPath
) {
  if (!releaseAssetBaseUrl || assetNames.length === 0) {
    return "";
  }

  const assetName = findPreferredAssetName(assetNames, pattern);
  if (!assetName) {
    return "";
  }

  const normalizedAssetPath = assetPath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${normalizeBaseUrl(releaseAssetBaseUrl)}/${normalizedAssetPath}/${encodeURIComponent(assetName)}`;
}

async function loadReleaseSummary(summaryPath) {
  if (!summaryPath) {
    return null;
  }

  try {
    return JSON.parse(await readFile(summaryPath, "utf8"));
  } catch {
    return null;
  }
}

function buildSummaryElements(summary) {
  const zh = summary?.zh;
  if (!zh?.headline || !Array.isArray(zh.sections)) {
    return [];
  }

  const updateLines = [];
  for (const section of zh.sections.slice(0, 4)) {
    const items = Array.isArray(section.items) ? section.items : [];
    for (const item of items) {
      updateLines.push(`- ${section.title}：${item}`);
      if (updateLines.length === 6) break;
    }
    if (updateLines.length === 6) break;
  }
  const content = [
    `**本次更新**\n${zh.headline}`,
    updateLines.length > 0 ? updateLines.join("\n") : ""
  ]
    .filter(Boolean)
    .join("\n");

  return [
    {
      tag: "div",
      text: {
        content,
        tag: "lark_md"
      }
    },
    { tag: "hr" }
  ];
}

function buildCandidatePromotionElements({ branch, promotionUrl, tag }) {
  if (!promotionUrl) {
    return [];
  }

  const branchInstruction = branch
    ? `- Branch 选择 \`${branch}\``
    : "- Branch 选择本次候选版本的 release 分支";
  return [
    {
      tag: "div",
      text: {
        content: [
          "**发布审核操作**",
          "1. 点击下方「打开发布审核流水线」",
          "2. 点击 `Run workflow`",
          branchInstruction,
          `- \`release_tag\` 填写 \`${tag}\``,
          "3. 启动后在 `Approve Stable Release` 完成审核"
        ].join("\n"),
        tag: "lark_md"
      }
    },
    { tag: "hr" }
  ];
}

function buildCardPayload({
  actor,
  branch,
  macUrl,
  winUrl,
  publicationStatus = "published",
  promotionUrl,
  releaseUrl,
  runUrl,
  summary,
  tag
}) {
  const deployActor = resolveDisplayValue(actor);
  const candidate = publicationStatus === "candidate";
  const actions = [
    { label: candidate ? "下载 macOS 体验版" : "下载 macOS", url: macUrl },
    {
      label: candidate ? "下载 Windows 体验版" : "下载 Windows（未签名）",
      url: winUrl
    },
    {
      label: candidate ? "编辑更新说明" : "查看完整更新日志",
      url: releaseUrl
    },
    ...(candidate
      ? [{ label: "打开发布审核流水线", url: promotionUrl }]
      : []),
    { label: "查看技术详情", url: runUrl }
  ]
    .filter((action) => action.url)
    .map((action, index) => ({
      tag: "button",
      text: { content: action.label, tag: "plain_text" },
      type: index === 0 ? "primary" : "default",
      url: action.url
    }));

  return {
    card: {
      config: { wide_screen_mode: true },
      elements: [
        {
          tag: "div",
          text: {
            content: resolveIntroText(tag, publicationStatus),
            tag: "lark_md"
          }
        },
        { tag: "hr" },
        ...buildSummaryElements(summary),
        ...(candidate
          ? buildCandidatePromotionElements({ branch, promotionUrl, tag })
          : []),
        {
          fields: [
            {
              is_short: true,
              text: { content: `**版本号**\n${tag}`, tag: "lark_md" }
            },
            {
              is_short: true,
              text: {
                content: `**构建类型**\n${resolveReleaseKind(tag, publicationStatus)}`,
                tag: "lark_md"
              }
            },
            {
              is_short: true,
              text: {
                content: `**部署人**\n${deployActor}`,
                tag: "lark_md"
              }
            },
            {
              is_short: true,
              text: {
                content: `**完成时间**\n${formatBuiltAt()} 北京时间`,
                tag: "lark_md"
              }
            }
          ],
          tag: "div"
        },
        { actions, tag: "action" }
      ],
      header: {
        template: candidate ? "orange" : "blue",
        title: {
          content: candidate ? "Tutti 候选版本待确认" : "Tutti 发布完成",
          tag: "plain_text"
        }
      }
    },
    msg_type: "interactive"
  };
}

async function sendPayload(webhookUrl, payload) {
  const response = await fetch(webhookUrl, {
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
    method: "POST"
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Feishu webhook returned ${response.status}: ${text}`);
  }
  return text;
}

async function main() {
  const args = parseArgs(process.argv);
  const dryRun =
    args.has("dry-run") || process.env.TUTTI_DESKTOP_FEISHU_DRY_RUN === "true";
  const repository = readOption(
    args,
    "repository",
    "GITHUB_REPOSITORY",
    `${RELEASE_REPO_OWNER}/${RELEASE_REPO_NAME}`
  );
  const tag = requireOption(
    readOption(args, "tag", "RELEASE_TAG"),
    "RELEASE_TAG"
  );
  const lookupTag = readOption(args, "lookup-tag", "RELEASE_LOOKUP_TAG", tag);
  const target = readOption(args, "target", "RELEASE_TARGET");
  const branch = readOption(args, "branch", "RELEASE_BRANCH");
  const actor = readOption(args, "actor", "RELEASE_ACTOR");
  const publicationStatus = readOption(
    args,
    "publication-status",
    "RELEASE_PUBLICATION_STATUS",
    "published"
  );
  if (publicationStatus !== "candidate" && publicationStatus !== "published") {
    throw new Error(
      "RELEASE_PUBLICATION_STATUS must be candidate or published"
    );
  }
  const releaseUrl = readOption(
    args,
    "release-url",
    "RELEASE_URL",
    `https://github.com/${repository}/releases/tag/${encodeURIComponent(tag)}`
  );
  const runUrl = readOption(args, "run-url", "RUN_URL");
  const promotionUrl = readOption(args, "promotion-url", "PROMOTION_URL");
  const webhookUrl = readOption(args, "webhook-url", "FEISHU_WEBHOOK_URL");
  const releaseAssetDirectory = readOption(
    args,
    "release-asset-directory",
    "RELEASE_ASSET_DIRECTORY"
  );
  const releaseAssetBaseUrl = resolveReleaseAssetBaseUrl({
    bucket: readOption(
      args,
      "release-asset-bucket",
      "TUTTI_DESKTOP_RELEASE_ASSETS_S3_BUCKET"
    ),
    explicitBaseUrl: readOption(
      args,
      "release-asset-base-url",
      "TUTTI_DESKTOP_RELEASE_ASSETS_BASE_URL"
    ),
    prefix: readOption(
      args,
      "release-asset-prefix",
      "TUTTI_DESKTOP_RELEASE_ASSETS_S3_PREFIX"
    )
  });
  const releaseAssetPath = readOption(
    args,
    "release-asset-path",
    "RELEASE_ASSET_PATH",
    tag
  );
  const mirroredAssetNames = await listAssetNames(releaseAssetDirectory);
  const mirroredMacUrl = resolveMirroredAssetUrl(
    mirroredAssetNames,
    /\.dmg$/i,
    releaseAssetBaseUrl,
    releaseAssetPath
  );
  const mirroredWinUrl = resolveMirroredAssetUrl(
    mirroredAssetNames,
    /-win-x64\.exe$/i,
    releaseAssetBaseUrl,
    releaseAssetPath
  );
  const release =
    mirroredMacUrl && mirroredWinUrl
      ? null
      : await loadRelease(repository, lookupTag, resolveGithubToken());
  const summary = await loadReleaseSummary(
    readOption(args, "summary", "RELEASE_SUMMARY_PATH")
  );
  const payload = buildCardPayload({
    actor,
    branch,
    macUrl:
      mirroredMacUrl ||
      findAssetUrl(release, /\.dmg$/i, releaseAssetBaseUrl, releaseAssetPath),
    winUrl:
      mirroredWinUrl ||
      findAssetUrl(
        release,
        /-win-x64\.exe$/i,
        releaseAssetBaseUrl,
        releaseAssetPath
      ),
    publicationStatus,
    promotionUrl,
    releaseUrl,
    runUrl,
    summary,
    tag,
    target
  });

  if (dryRun) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  requireOption(webhookUrl, "FEISHU_WEBHOOK_URL");
  console.log(await sendPayload(webhookUrl, payload));
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
  buildCardPayload,
  buildCandidatePromotionElements,
  buildSummaryElements,
  findPreferredAssetName,
  loadRelease,
  loadReleaseSummary,
  listAssetNames,
  resolveMirroredAssetUrl,
  resolveIntroText,
  resolveReleaseAssetBaseUrl,
  resolveReleaseKind
};
