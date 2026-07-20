import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFallbackReleaseSummary,
  classifyCommit,
  normalizeSectionTitle,
  normalizeVersion,
  resolveChannel
} from "../../apps/desktop/scripts/generate-release-summary.mjs";
import {
  GITHUB_RELEASE_BODY_MAX_LENGTH,
  RELEASE_NOTES_TRUNCATION_NOTICE
} from "../../apps/desktop/scripts/lib/githubReleaseBody.mjs";
import { resolvePreviousReleaseTag } from "../../apps/desktop/scripts/lib/previousReleaseTag.mjs";
import {
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody
} from "../../apps/desktop/scripts/upsert-release-summary.mjs";

test("desktop release summary classifies commit messages for human sections", () => {
  assert.equal(
    classifyCommit("abc1234 feat(update): add channel picker"),
    "功能变更"
  );
  assert.equal(
    classifyCommit("abc1234 fix(release): avoid rc latest"),
    "问题修复"
  );
  assert.equal(
    classifyCommit("abc1234 chore(release): update desktop workflow"),
    "发布与更新"
  );
});

test("desktop release summary maps technical headings to user-facing sections", () => {
  assert.equal(normalizeSectionTitle("核心功能与架构", "zh"), "功能变更");
  assert.equal(normalizeSectionTitle("后端与服务端改进", "zh"), "体验优化");
  assert.equal(
    normalizeSectionTitle("Core Features & Architecture", "en"),
    "Feature Updates"
  );
  assert.equal(
    normalizeSectionTitle("Backend & Service Enhancements", "en"),
    "Experience Improvements"
  );
});

test("desktop release summary resolves channel from version shape", () => {
  assert.equal(normalizeVersion("v1.2.4"), "1.2.4");
  assert.equal(normalizeVersion("tutti-desktop-v1.2.4-rc.1"), "1.2.4-rc.1");
  assert.equal(normalizeVersion("tutti-desktop-v1.2.4-beta.1"), "1.2.4-beta.1");
  assert.equal(resolveChannel({ version: "1.2.4" }), "stable");
  assert.equal(resolveChannel({ version: "1.2.4-rc.1" }), "rc");
  assert.equal(resolveChannel({ version: "1.2.4-beta.1" }), "beta");
});

test("GitHub release notes compare prereleases against the latest same-channel tag", () => {
  const previousTag = resolvePreviousReleaseTag({
    channel: "rc",
    tag: "v0.2.2-rc.9",
    tags: ["v0.2.2-rc.9", "v0.2.2-rc.8", "v0.2.2-beta.5", "v0.2.0"],
    version: "0.2.2-rc.9"
  });

  assert.equal(previousTag, "v0.2.2-rc.8");
});

test("GitHub release notes fall back to the latest stable tag", () => {
  const previousTag = resolvePreviousReleaseTag({
    channel: "beta",
    tag: "v0.3.0-beta.0",
    tags: ["v0.3.0-beta.0", "v0.2.2-rc.8", "v0.2.1", "v0.2.0"],
    version: "0.3.0-beta.0"
  });

  assert.equal(previousTag, "v0.2.1");
});

test("desktop release summary fallback emits zh and en sections", () => {
  const summary = buildFallbackReleaseSummary({
    commits: [
      "abc1234 feat(update): add release channel picker",
      "def5678 fix(release): keep rc out of latest metadata"
    ]
  });

  assert.equal(summary.source, "fallback");
  assert.match(summary.zh.headline, /桌面端/);
  assert.ok(summary.zh.sections.length >= 2);
  assert.ok(summary.en.sections.length >= 2);
});

test("desktop release summary upserts a managed GitHub release section", () => {
  const nextBody = buildUpdatedReleaseBody({
    existingBody: [
      "## What's Changed",
      "- Raw GitHub note",
      "",
      SECTION_START,
      "old summary",
      SECTION_END
    ].join("\n"),
    summary: {
      zh: {
        headline: "本次版本聚焦发布链路稳定性。",
        sections: [
          { title: "发布与更新", items: ["稳定包入口只指向正式版。"] }
        ],
        qaFocus: ["验证下载入口。"]
      },
      en: {
        headline: "This release focuses on release stability.",
        sections: [
          {
            title: "Release and Updates",
            items: ["Stable downloads only point to official releases."]
          }
        ],
        qaFocus: ["Verify the download entry."]
      }
    }
  });

  assert.equal(nextBody.match(new RegExp(SECTION_START, "g"))?.length, 1);
  assert.doesNotMatch(nextBody, /本次版本聚焦发布链路稳定性/);
  assert.match(nextBody, /Stable downloads only point to official releases/);
  assert.match(nextBody, /Highlights/);
  assert.doesNotMatch(nextBody, /QA Focus/);
  assert.doesNotMatch(nextBody, /Verify the download entry/);
  assert.match(nextBody, /Raw GitHub note/);
  assert.doesNotMatch(nextBody, /old summary/);
});

test("desktop release summary trims only generated notes at GitHub's body limit", () => {
  const oversizedNotes = [
    "## What's Changed",
    ...Array.from(
      { length: 2_000 },
      (_, index) => `- generated note ${index}: ${"x".repeat(80)}`
    )
  ].join("\n");
  const nextBody = buildUpdatedReleaseBody({
    existingBody: oversizedNotes,
    summary: {
      en: {
        headline: "A concise release summary.",
        sections: [{ title: "Bug Fixes", items: ["Kept releases reliable."] }]
      }
    }
  });

  assert.ok(nextBody.length <= GITHUB_RELEASE_BODY_MAX_LENGTH);
  assert.match(nextBody, /A concise release summary/);
  assert.match(nextBody, /generated note 0:/);
  assert.doesNotMatch(nextBody, /generated note 1999:/);
  assert.ok(nextBody.includes(RELEASE_NOTES_TRUNCATION_NOTICE));
});
