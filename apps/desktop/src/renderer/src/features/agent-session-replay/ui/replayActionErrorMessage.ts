const maximumReplayErrorCharacters = 240;
const expectedStateMismatchPattern =
  /expected state mismatch in ([a-z0-9_]+)/iu;

export function replayActionErrorMessage(
  error: unknown,
  stateMismatchMessage: (table: string) => string
): string {
  const message = error instanceof Error ? error.message : String(error);
  const mismatch = expectedStateMismatchPattern.exec(message);
  const mismatchTable = mismatch?.[1];
  if (mismatchTable) {
    return stateMismatchMessage(mismatchTable);
  }
  const firstLine = message.split(/\r?\n|\\n/u, 1)[0]?.trim() ?? "";
  if (firstLine.length <= maximumReplayErrorCharacters) {
    return firstLine;
  }
  return `${firstLine.slice(0, maximumReplayErrorCharacters - 1)}…`;
}
