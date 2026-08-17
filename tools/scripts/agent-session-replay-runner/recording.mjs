import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  assertForbiddenPathAbsent as assertForbiddenPathAbsentCore,
  resolveRecordScenarioProject as resolveRecordScenarioProjectCore,
  seedRecordingUserProject as seedRecordingUserProjectCore,
  verifyRecordedProjectBindingArtifacts as verifyRecordedProjectBindingArtifactsCore
} from "../../../packages/agent/session-replay-runner/src/recording.mjs";
import {
  cassettePolicy,
  parseActivityEvents,
  portableReplayCWDToken,
  resolveAgentSessionReplayProjectRoot
} from "./cassette.mjs";

export { resolveAgentSessionReplayProjectRoot };

const activityEventsName = cassettePolicy.files.activityEvents.path;
const checkpointPlanName = cassettePolicy.files.checkpointPlan.path;
const expectedStateName = cassettePolicy.files.expectedState.path;
const initialStateName = cassettePolicy.files.initialState.path;

function canonicalizeProjectPath(path) {
  const absolute = resolve(String(path ?? "").trim());
  if (!absolute) return absolute;
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

export function resolveRecordScenarioProject(project, replayCWD) {
  return resolveRecordScenarioProjectCore(project, replayCWD, {
    canonicalizePath: canonicalizeProjectPath,
    portableReplayCWDToken
  });
}

export async function seedRecordingUserProject(databasePath, project) {
  return seedRecordingUserProjectCore(databasePath, project, {
    canonicalizePath: canonicalizeProjectPath
  });
}

export async function verifyRecordedProjectBindingArtifacts(
  recordingDirectory,
  portableProjectPath
) {
  return verifyRecordedProjectBindingArtifactsCore(
    recordingDirectory,
    portableProjectPath,
    {
      activityEventsPath: activityEventsName,
      checkpointPlanPath: checkpointPlanName,
      expectedStatePath: expectedStateName,
      initialStatePath: initialStateName,
      parseActivityEvents
    }
  );
}

export async function assertForbiddenPathAbsent(path, scenarioId) {
  return assertForbiddenPathAbsentCore(path, scenarioId);
}
