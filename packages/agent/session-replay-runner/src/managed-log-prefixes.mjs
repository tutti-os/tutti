export const managedReplayReadyPrefix = "[tutti-agent-session-replay-ready] ";
export const managedReplayCompletePrefix =
  "[tutti-agent-session-replay-complete] ";
export const managedReplayFailedPrefix = "[tutti-agent-session-replay-failed] ";
export const managedReplayCheckpointPrefix =
  "[tutti-agent-session-replay-checkpoint] ";
export const managedReplayReplacePrefix =
  "[tutti-agent-session-replay-replace] ";

/** schemaVersion 2 control router document for one cassette command. */
export function replayControlRouter(
  cassetteId,
  revision,
  command,
  fields = {}
) {
  return {
    schemaVersion: 2,
    cassettes: {
      [cassetteId]: {
        command,
        revision,
        ...fields
      }
    }
  };
}
