import assert from "node:assert/strict";
import test from "node:test";

import {
  buildReleaseApprovalDigest,
  createReleaseCandidateManifest,
  validateReleaseCandidateManifest
} from "../../apps/desktop/scripts/lib/releaseCandidate.mjs";

function createManifest() {
  return createReleaseCandidateManifest({
    candidateId: "v1.2.3-abcdef0-run42-1",
    tag: "v1.2.3",
    version: "1.2.3",
    targetCommit: "abcdef0123456789abcdef0123456789abcdef01",
    sourceRef: "release/1.2",
    createdAt: "2026-08-17T00:00:00.000Z",
    workflowRunUrl: "https://github.example/runs/42",
    checksums: "hash  Tutti.dmg\n",
    generatedSummary: '{"tag":"v1.2.3"}\n'
  });
}

test("stable candidate manifest binds the planned version, artifacts, and generated summary", () => {
  const manifest = createManifest();
  assert.equal(manifest.tag, "v1.2.3");
  assert.equal(manifest.channel, "stable");
  assert.equal(
    validateReleaseCandidateManifest(manifest, {
      tag: "v1.2.3",
      targetCommit: "abcdef0123456789abcdef0123456789abcdef01",
      checksums: "hash  Tutti.dmg\n",
      generatedSummary: '{"tag":"v1.2.3"}\n'
    }),
    manifest
  );
  assert.throws(
    () =>
      validateReleaseCandidateManifest(manifest, {
        checksums: "different",
        generatedSummary: '{"tag":"v1.2.3"}\n'
      }),
    /checksums digest/
  );
});

test("approval digest changes when either reviewed notes or the candidate changes", () => {
  const manifest = createManifest();
  const approved = { summarySource: "human-reviewed", zh: { headline: "A" } };
  const digest = buildReleaseApprovalDigest(manifest, approved);
  assert.notEqual(
    digest,
    buildReleaseApprovalDigest(manifest, {
      ...approved,
      zh: { headline: "B" }
    })
  );
  assert.notEqual(
    digest,
    buildReleaseApprovalDigest({ ...manifest, candidateId: "other" }, approved)
  );
});

test("stable candidate manifest requires an immutable full commit SHA", () => {
  assert.throws(
    () =>
      createReleaseCandidateManifest({
        candidateId: "v1.2.3-abcdef0-run42-1",
        tag: "v1.2.3",
        version: "1.2.3",
        targetCommit: "main",
        sourceRef: "main",
        createdAt: "2026-08-17T00:00:00.000Z",
        workflowRunUrl: "https://github.example/runs/42",
        checksums: "hash  Tutti.dmg\n",
        generatedSummary: '{"tag":"v1.2.3"}\n'
      }),
    /full Git commit SHA/
  );
});
