export function latestProviderStatusLogLine(
  log: readonly string[]
): string | null {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const line = log[index]?.trim();
    if (line) return line;
  }
  return null;
}
