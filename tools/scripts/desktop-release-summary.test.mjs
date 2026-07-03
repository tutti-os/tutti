import test from "node:test";
import assert from "node:assert/strict";

import {
  buildFallbackReleaseSummary,
  classifyCommit,
  normalizeVersion,
  resolveChannel
} from "../../apps/desktop/scripts/generate-release-summary.mjs";
import {
  SECTION_END,
  SECTION_START,
  buildUpdatedReleaseBody
} from "../../apps/desktop/scripts/upsert-release-summary.mjs";

test("desktop release summary classifies commit messages for human sections", () => {
  assert.equal(classifyCommit("abc1234 feat(update): add channel picker"), "新功能");
  assert.equal(classifyCommit("abc1234 fix(release): avoid rc latest"), "Bug Fix");
  assert.equal(
    classifyCommit("abc1234 chore(release): update desktop workflow"),
    "发布与下载"
  );
});

test("desktop release summary resolves channel from version shape", () => {
  assert.equal(normalizeVersion("v1.2.4"), "1.2.4");
  assert.equal(normalizeVersion("tutti-desktop-v1.2.4-rc.1"), "1.2.4-rc.1");
  assert.equal(resolveChannel({ version: "1.2.4" }), "stable");
  assert.equal(resolveChannel({ version: "1.2.4-rc.1" }), "rc");
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
        sections: [{ title: "发布与下载", items: ["稳定包入口只指向正式版。"] }],
        qaFocus: ["验证下载入口。"]
      },
      en: {
        headline: "This release focuses on release stability.",
        sections: [
          {
            title: "Release and Downloads",
            items: ["Stable downloads only point to official releases."]
          }
        ],
        qaFocus: ["Verify the download entry."]
      }
    }
  });

  assert.equal(nextBody.match(new RegExp(SECTION_START, "g"))?.length, 1);
  assert.match(nextBody, /本次版本聚焦发布链路稳定性/);
  assert.match(nextBody, /Stable downloads only point to official releases/);
  assert.match(nextBody, /Raw GitHub note/);
  assert.doesNotMatch(nextBody, /old summary/);
});
