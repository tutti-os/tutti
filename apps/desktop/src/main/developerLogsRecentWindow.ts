import { readFile } from "node:fs/promises";

export interface DeveloperLogsTimeWindow {
  endTimeUnixMs: number;
  startTimeUnixMs: number;
}

export interface DeveloperLogFileArtifact {
  archivePath: string;
  category: "app-factory-log" | "managed-log" | "workspace-app-log";
  clearable: true;
  clearMode: "remove" | "truncate";
  kind: "file";
  modifiedAtUnixMs: number;
  path: string;
  sizeBytes: number;
}

type PreparedDeveloperLogFile = DeveloperLogFileArtifact & {
  content: Buffer;
};

export async function prepareDeveloperLogFilesForExport(
  artifacts: DeveloperLogFileArtifact[],
  timeWindow: DeveloperLogsTimeWindow | null
): Promise<PreparedDeveloperLogFile[]> {
  const prepared = await Promise.all(
    artifacts.map(
      async (artifact): Promise<PreparedDeveloperLogFile | null> => {
        const originalContent = await readFile(artifact.path);
        const content = timeWindow
          ? filterDeveloperLogContentByTime({
              content: originalContent,
              modifiedAtUnixMs: artifact.modifiedAtUnixMs,
              timeWindow
            })
          : originalContent;

        if (content === null || (timeWindow && content.byteLength === 0)) {
          return null;
        }

        return {
          ...artifact,
          content,
          sizeBytes: content.byteLength
        };
      }
    )
  );

  return prepared.filter(
    (artifact): artifact is PreparedDeveloperLogFile => artifact !== null
  );
}

function filterDeveloperLogContentByTime(input: {
  content: Buffer;
  modifiedAtUnixMs: number;
  timeWindow: DeveloperLogsTimeWindow;
}): Buffer | null {
  const segments = input.content
    .toString("utf8")
    .match(/[^\r\n]*(?:\r\n|\n|\r|$)/g)
    ?.filter((segment) => segment.length > 0);
  if (!segments || segments.length === 0) {
    return null;
  }

  let foundTimestamp = false;
  let includeContinuation = false;
  const selectedSegments: string[] = [];

  for (const segment of segments) {
    const timestamp = parseDeveloperLogTimestamp(segment);
    if (timestamp !== null) {
      foundTimestamp = true;
      includeContinuation =
        timestamp >= input.timeWindow.startTimeUnixMs &&
        timestamp <= input.timeWindow.endTimeUnixMs;
    }

    if (includeContinuation) {
      selectedSegments.push(segment);
    }
  }

  if (foundTimestamp) {
    return Buffer.from(selectedSegments.join(""), "utf8");
  }

  const fileWasUpdatedInWindow =
    input.modifiedAtUnixMs >= input.timeWindow.startTimeUnixMs &&
    input.modifiedAtUnixMs <= input.timeWindow.endTimeUnixMs;
  return fileWasUpdatedInWindow ? input.content : null;
}

function parseDeveloperLogTimestamp(line: string): number | null {
  const structuredTime = line.match(/(?:^|\s)time=(?:"([^"]+)"|(\S+))/);
  const structuredValue = structuredTime?.[1] ?? structuredTime?.[2];
  if (structuredValue) {
    const parsed = Date.parse(structuredValue);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const trimmed = line.trim();
  if (trimmed.startsWith("{")) {
    try {
      const record = JSON.parse(trimmed) as Record<string, unknown>;
      const value = record.time ?? record.timestamp;
      if (typeof value === "number" && Number.isFinite(value)) {
        return value < 10_000_000_000 ? value * 1_000 : value;
      }
      if (typeof value === "string") {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed)) {
          return parsed;
        }
      }
    } catch {
      // Fall through to the generic ISO timestamp probe.
    }
  }

  const isoTimestamp = line.match(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/
  )?.[0];
  if (!isoTimestamp) {
    return null;
  }
  const parsed = Date.parse(isoTimestamp);
  return Number.isFinite(parsed) ? parsed : null;
}
