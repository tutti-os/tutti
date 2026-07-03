import test from "node:test";
import assert from "node:assert/strict";

import {
  parseExistingChangelog,
  schemaVersion,
  upsertChangelogEntry
} from "../../apps/desktop/scripts/upsert-release-changelog.mjs";

function createSummary(version, generatedAt) {
  return {
    tag: `v${version}`,
    version,
    channel: "stable",
    prerelease: false,
    generatedAt,
    targetCommit: "537327a1",
    compare: { from: `v${version}-previous`, to: "HEAD", range: "test" },
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
  };
}

test("desktop release changelog treats missing existing json as empty", () => {
  const changelog = parseExistingChangelog("");

  assert.equal(changelog.schemaVersion, schemaVersion);
  assert.deepEqual(changelog.entries, []);
});

test("desktop release changelog rejects invalid existing json", () => {
  assert.throws(
    () => parseExistingChangelog("not json"),
    /Existing changelog is not valid JSON/
  );
  assert.throws(
    () => parseExistingChangelog('{"entries":[]}'),
    /Existing changelog must use schema/
  );
});

test("desktop release changelog upserts versions and keeps newest first", () => {
  const first = upsertChangelogEntry("", createSummary("1.2.3", "2026-07-03T12:00:00.000Z"));
  const second = upsertChangelogEntry(
    first,
    createSummary("1.2.4", "2026-07-04T12:00:00.000Z")
  );
  const replaced = upsertChangelogEntry(
    second,
    createSummary("1.2.3", "2026-07-05T12:00:00.000Z")
  );

  assert.deepEqual(
    replaced.entries.map((entry) => entry.version),
    ["1.2.3", "1.2.4"]
  );
  assert.equal(replaced.entries[0]?.zh.headline, "本次版本聚焦发布链路稳定性。");
});
