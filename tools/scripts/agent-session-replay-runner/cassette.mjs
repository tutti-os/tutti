import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createCassetteHelpers } from "../../../packages/agent/session-replay-runner/src/cassette.mjs";
import { loadCassettePolicy } from "../../../packages/agent/session-replay-runner/src/cassette-policy.mjs";
import { resolveAgentSessionReplayProjectRoot } from "./project-root.mjs";

export { resolveAgentSessionReplayProjectRoot } from "./project-root.mjs";
export { portableReplayCWDToken } from "../../../packages/agent/session-replay-runner/src/cassette.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const workspaceRoot = resolve(scriptDirectory, "..", "..", "..");

export const cassettePolicy = await loadCassettePolicy(
  join(
    workspaceRoot,
    "packages",
    "agent",
    "session-replay",
    "cassette-policy.json"
  )
);

const helpers = createCassetteHelpers(cassettePolicy, {
  canonicalizeResolvedPaths: true
});

export const verifyCassette = helpers.verifyCassette;
export const parseActivityEvents = helpers.parseActivityEvents;
export const materializeReplayWorkspaceBlobs =
  helpers.materializeReplayWorkspaceBlobs;
export const resolvePortableActivityEventPayload =
  helpers.resolvePortableActivityEventPayload;
export const loadReplayTurnIdentityPlan = helpers.loadReplayTurnIdentityPlan;
export const replayTurnIdentityPlan = helpers.replayTurnIdentityPlan;

export function replayActionFromManifest(
  manifest,
  activityEvents,
  workspaceId
) {
  return helpers.replayActionFromManifest(
    manifest,
    activityEvents,
    workspaceId,
    resolveAgentSessionReplayProjectRoot()
  );
}
