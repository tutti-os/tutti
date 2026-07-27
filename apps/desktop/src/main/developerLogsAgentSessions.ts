export interface DeveloperLogsAgentSessionRecord {
  agentSessionID: string;
  hasMoreMessages: boolean;
  latestMessageVersion: number;
  messages: unknown[];
  provider: "claude-code" | "codex" | "cursor" | "tutti-agent";
  providerSessionID: string;
  session: unknown;
  updatedAtUnixMS: number;
  workspaceID: string;
}

export interface ExportedAgentSessionFile {
  agentSessionID: string;
  archivePath: string;
  content: Buffer;
  path: string;
  provider: "claude-code" | "codex" | "cursor" | "tutti-agent";
  sizeBytes: number;
  workspaceID: string;
}

const agentSessionExportLimitPerProvider = 10;

export function buildProviderAgentSessionRecordFiles(
  records: readonly DeveloperLogsAgentSessionRecord[],
  now = new Date()
): ExportedAgentSessionFile[] {
  return selectRecentAgentSessionsByProvider(records).flatMap((record) => {
    const exportedAt = now.toISOString();
    const sessionDir = joinZipPath(
      "agent-sessions",
      safeZipPathSegment(record.provider),
      safeZipPathSegment(record.workspaceID),
      safeZipPathSegment(record.agentSessionID)
    );
    const manifest = jsonBuffer({
      schemaVersion: 1,
      exportedAt,
      workspaceId: record.workspaceID,
      agentSessionId: record.agentSessionID,
      provider: record.provider,
      providerSessionId: record.providerSessionID,
      latestMessageVersion: record.latestMessageVersion,
      hasMoreMessages: record.hasMoreMessages,
      messageCount: record.messages.length,
      files: {
        session: "session.json",
        messages: "messages.jsonl"
      }
    });
    const session = jsonBuffer({
      schemaVersion: 1,
      exportedAt,
      workspaceId: record.workspaceID,
      agentSessionId: record.agentSessionID,
      provider: record.provider,
      providerSessionId: record.providerSessionID,
      session: record.session
    });
    const messages = Buffer.from(
      record.messages.map((message) => JSON.stringify(message)).join("\n") +
        (record.messages.length > 0 ? "\n" : ""),
      "utf8"
    );

    return [
      createExportedAgentSessionFile(
        record,
        sessionDir,
        "manifest.json",
        manifest
      ),
      createExportedAgentSessionFile(
        record,
        sessionDir,
        "session.json",
        session
      ),
      createExportedAgentSessionFile(
        record,
        sessionDir,
        "messages.jsonl",
        messages
      )
    ];
  });
}

function createExportedAgentSessionFile(
  record: DeveloperLogsAgentSessionRecord,
  sessionDir: string,
  fileName: string,
  content: Buffer
): ExportedAgentSessionFile {
  return {
    agentSessionID: record.agentSessionID,
    archivePath: joinZipPath(sessionDir, fileName),
    content,
    path: `tuttid-db://${record.workspaceID}/${record.agentSessionID}/${fileName}`,
    provider: record.provider,
    sizeBytes: content.byteLength,
    workspaceID: record.workspaceID
  };
}

function jsonBuffer(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), "utf8");
}

function selectRecentAgentSessionsByProvider(
  records: readonly DeveloperLogsAgentSessionRecord[]
): DeveloperLogsAgentSessionRecord[] {
  const byProvider = new Map<
    DeveloperLogsAgentSessionRecord["provider"],
    DeveloperLogsAgentSessionRecord[]
  >();
  for (const record of records) {
    const providerRecords = byProvider.get(record.provider) ?? [];
    providerRecords.push(record);
    byProvider.set(record.provider, providerRecords);
  }

  return [...byProvider.values()].flatMap((providerRecords) =>
    providerRecords
      .sort(
        (left, right) =>
          right.updatedAtUnixMS - left.updatedAtUnixMS ||
          left.agentSessionID.localeCompare(right.agentSessionID)
      )
      .slice(0, agentSessionExportLimitPerProvider)
  );
}

function joinZipPath(...parts: string[]): string {
  return parts
    .map((part) => part.replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}

function safeZipPathSegment(value: string): string {
  const safe = value.trim().replaceAll(/[^\p{L}\p{N}_.-]/gu, "_");
  if (safe === "" || safe === "." || safe === "..") {
    return "_";
  }
  return safe;
}
