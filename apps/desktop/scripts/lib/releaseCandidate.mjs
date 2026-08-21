import { createHash } from "node:crypto";

const candidateSchemaVersion = "tutti.desktop.release.candidate.v1";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireString(value, label) {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Error(`${label} is required`);
  }
  return normalized;
}

function createReleaseCandidateManifest(input) {
  const tag = requireString(input.tag, "tag");
  const version = requireString(input.version, "version");
  const candidateId = requireString(input.candidateId, "candidateId");
  if (tag !== `v${version}` || !/^v\d+\.\d+\.\d+$/u.test(tag)) {
    throw new Error("stable candidate tag and version must match");
  }
  if (!candidateId.startsWith(`${tag}-`)) {
    throw new Error("candidateId must start with the planned tag");
  }

  const targetCommit = requireString(input.targetCommit, "targetCommit");
  if (!/^[a-f0-9]{40}$/u.test(targetCommit)) {
    throw new Error("targetCommit must be a full Git commit SHA");
  }

  return {
    schemaVersion: candidateSchemaVersion,
    candidateId,
    tag,
    version,
    channel: "stable",
    targetCommit,
    sourceRef: requireString(input.sourceRef, "sourceRef"),
    createdAt: requireString(input.createdAt, "createdAt"),
    workflowRunUrl: requireString(input.workflowRunUrl, "workflowRunUrl"),
    checksumsSha256: sha256(requireString(input.checksums, "checksums")),
    generatedSummarySha256: sha256(
      requireString(input.generatedSummary, "generatedSummary")
    )
  };
}

function validateReleaseCandidateManifest(manifest, expected = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("candidate manifest must be an object");
  }
  if (manifest.schemaVersion !== candidateSchemaVersion) {
    throw new Error(`unexpected candidate schema: ${manifest.schemaVersion}`);
  }
  const normalized = createReleaseCandidateManifest({
    ...manifest,
    checksums: expected.checksums,
    generatedSummary: expected.generatedSummary
  });
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (
      field !== "checksums" &&
      field !== "generatedSummary" &&
      expectedValue &&
      normalized[field] !== expectedValue
    ) {
      throw new Error(`candidate manifest ${field} does not match`);
    }
  }
  if (manifest.checksumsSha256 !== normalized.checksumsSha256) {
    throw new Error("candidate checksums digest does not match");
  }
  if (manifest.generatedSummarySha256 !== normalized.generatedSummarySha256) {
    throw new Error("candidate summary digest does not match");
  }
  return manifest;
}

function buildReleaseApprovalDigest(manifest, approvedSummary) {
  return sha256(
    JSON.stringify({
      candidateId: manifest.candidateId,
      checksumsSha256: manifest.checksumsSha256,
      generatedSummarySha256: manifest.generatedSummarySha256,
      tag: manifest.tag,
      targetCommit: manifest.targetCommit,
      approvedSummary
    })
  );
}

export {
  buildReleaseApprovalDigest,
  candidateSchemaVersion,
  createReleaseCandidateManifest,
  validateReleaseCandidateManifest
};
