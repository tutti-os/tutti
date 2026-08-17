import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { buildUpdatedReleaseBody } from "../../apps/desktop/scripts/upsert-release-summary.mjs";

const execFileAsync = promisify(execFile);
const scriptsDir = path.resolve("apps/desktop/scripts");

test("stable candidate survives build, human edit, extraction, and approval verification", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "desktop-release-candidate-"));
  const env = {
    ...process.env,
    RELEASE_CANDIDATE_ID: "v1.2.3-abcdef0-run42-1",
    RELEASE_CHANNEL: "stable",
    RELEASE_RUN_URL: "https://github.example/runs/42",
    RELEASE_SOURCE_REF: "release/1.2",
    RELEASE_TAG: "v1.2.3",
    RELEASE_TARGET: "abcdef0123456789abcdef0123456789abcdef01",
    RELEASE_VERSION: "1.2.3"
  };
  const generated = createSummary();

  try {
    await writeFile(path.join(dir, "SHA256SUMS.txt"), "hash  Tutti.dmg\n");
    await writeFile(
      path.join(dir, "generated.json"),
      `${JSON.stringify(generated)}\n`
    );
    await execFileAsync(
      "node",
      [
        path.join(scriptsDir, "build-release-candidate-manifest.mjs"),
        path.join(dir, "SHA256SUMS.txt"),
        path.join(dir, "generated.json"),
        path.join(dir, "candidate.json")
      ],
      { env }
    );

    const seededBody = buildUpdatedReleaseBody({
      existingBody: "Generated GitHub notes",
      summary: generated
    });
    await writeFile(
      path.join(dir, "release-body.md"),
      seededBody.replace("生成的功能说明", "人工确认后的功能说明")
    );
    await execFileAsync(
      "node",
      [
        path.join(scriptsDir, "extract-approved-release-summary.mjs"),
        path.join(dir, "release-body.md"),
        path.join(dir, "generated.json"),
        path.join(dir, "approved.json")
      ],
      { env }
    );
    const { stdout } = await execFileAsync(
      "node",
      [
        path.join(scriptsDir, "verify-release-candidate.mjs"),
        path.join(dir, "candidate.json"),
        path.join(dir, "SHA256SUMS.txt"),
        path.join(dir, "generated.json"),
        path.join(dir, "approved.json")
      ],
      { env }
    );

    const verified = JSON.parse(stdout);
    const approved = JSON.parse(
      await readFile(path.join(dir, "approved.json"))
    );
    assert.equal(verified.candidateId, env.RELEASE_CANDIDATE_ID);
    assert.match(verified.approvalDigest, /^[a-f0-9]{64}$/);
    assert.equal(approved.summarySource, "human-reviewed");
    assert.equal(approved.zh.sections[0].items[0], "人工确认后的功能说明");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

function createSummary() {
  return {
    schemaVersion: "tutti.desktop.release.summary.v1",
    tag: "v1.2.3",
    version: "1.2.3",
    channel: "stable",
    prerelease: false,
    targetCommit: "abcdef0123456789abcdef0123456789abcdef01",
    generatedAt: "2026-08-17T00:00:00.000Z",
    summarySource: "agnes",
    compare: {
      from: "v1.2.2",
      to: "abcdef0123456789abcdef0123456789abcdef01",
      range: "v1.2.2..abcdef0123456789abcdef0123456789abcdef01"
    },
    zh: {
      headline: "本次更新改善了桌面体验。",
      sections: [{ title: "新功能", items: ["生成的功能说明"] }],
      qaFocus: []
    },
    en: {
      headline: "This update improves the desktop experience.",
      sections: [{ title: "Features", items: ["Generated feature note"] }],
      qaFocus: []
    }
  };
}
