import { readFile } from "node:fs/promises";

/**
 * Load and lightly validate a Cassette policy document.
 * Products choose the JSON path. Published consumers should resolve the
 * package's `cassette-policy.json` export and pass that installed path here.
 */
export async function loadCassettePolicy(policyPath) {
  const path = String(policyPath ?? "").trim();
  if (!path) {
    throw new Error("cassette policy path is required");
  }
  const policy = JSON.parse(await readFile(path, "utf8"));
  assertCassettePolicyShape(policy, path);
  return policy;
}

export function assertCassettePolicyShape(policy, source = "cassette-policy") {
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    !Number.isSafeInteger(policy.schemaVersion) ||
    policy.schemaVersion < 1 ||
    !policy.files ||
    typeof policy.files !== "object" ||
    Array.isArray(policy.files) ||
    !policy.limits ||
    typeof policy.limits !== "object"
  ) {
    throw new Error(`cassette policy is invalid: ${source}`);
  }
  return policy;
}
