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
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody
} from "../../apps/desktop/scripts/upsert-release-summary.mjs";

test("desktop release summary classifies commit messages for human sections", () => {
  assert.equal(classifyCommit("abc1234 feat(update): add channel picker"), "功能变更");
  assert.equal(classifyCommit("abc1234 fix(release): avoid rc latest"), "问题修复");
  assert.equal(
    classifyCommit("abc1234 chore(release): update desktop workflow"),
    "发布与更新"
  );
});

test("desktop release summary maps technical headings to user-facing sections", () => {
  assert.equal(normalizeSectionTitle("核心功能与架构", "zh"), "功能变更");
  assert.equal(normalizeSectionTitle("后端与服务端改进", "zh"), "体验优化");
  assert.equal(normalizeSectionTitle("Core Features & Architecture", "en"), "Feature Updates");
  assert.equal(normalizeSectionTitle("Backend & Service Enhancements", "en"), "Experience Improvements");
});

test("desktop release summary resolves channel from version shape", () => {
  assert.equal(normalizeVersion("v1.2.4"), "1.2.4");
  assert.equal(normalizeVersion("tutti-desktop-v1.2.4-rc.1"), "1.2.4-rc.1");
  assert.equal(normalizeVersion("tutti-desktop-v1.2.4-beta.1"), "1.2.4-beta.1");
  assert.equal(resolveChannel({ version: "1.2.4" }), "stable");
  assert.equal(resolveChannel({ version: "1.2.4-rc.1" }), "rc");
  assert.equal(resolveChannel({ version: "1.2.4-beta.1" }), "beta");
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
        sections: [{ title: "发布与更新", items: ["稳定包入口只指向正式版。"] }],
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
