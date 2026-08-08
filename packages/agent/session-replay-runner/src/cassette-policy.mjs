import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Load and lightly validate a Cassette policy document.
 * Products choose the JSON path; this helper stays path-agnostic so TSH can
 * keep a local policy copy while Tutti points at packages/agent/session-replay.
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

/** Default Tutti checkout path for the shared Go cassette-policy.json. */
export function defaultTuttiCassettePolicyPath(tuttiCheckoutRoot) {
  const root = String(tuttiCheckoutRoot ?? "").trim();
  if (!root) {
    throw new Error(
      "Tutti checkout root is required for default cassette policy"
    );
  }
  return join(
    root,
    "packages",
    "agent",
    "session-replay",
    "cassette-policy.json"
  );
}
