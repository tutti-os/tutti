export interface DeveloperLogsAgentSessionAttachment {
  attachmentID: string;
  dataBase64: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  name?: string;
}

export interface DeveloperLogsAgentSessionRecord {
  agentSessionID: string;
  attachments?: DeveloperLogsAgentSessionAttachment[];
  hasMoreMessages: boolean;
  latestMessageVersion: number;
  messages: unknown[];
  provider: "claude-code" | "codex" | "cursor" | "tutti-agent";
  providerSessionID: string;
  session: unknown;
  updatedAtUnixMS: number;
  unavailableAttachmentIDs?: string[];
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
    const attachmentFiles = (record.attachments ?? []).flatMap((attachment) => {
      const extension = imageExtension(attachment.mimeType);
      if (!extension) return [];
      const fileName = `${safeZipPathSegment(attachment.attachmentID)}${extension}`;
      const content = Buffer.from(attachment.dataBase64, "base64");
      return [
        {
          attachmentID: attachment.attachmentID,
          archivePath: joinZipPath(sessionDir, "attachments", fileName),
          content,
          fileName: joinZipPath("attachments", fileName),
          mimeType: attachment.mimeType,
          ...(attachment.name ? { name: attachment.name } : {}),
          sizeBytes: content.byteLength
        }
      ];
    });
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
      attachments: attachmentFiles.map((attachment) => ({
        attachmentId: attachment.attachmentID,
        mimeType: attachment.mimeType,
        ...(attachment.name ? { name: attachment.name } : {}),
        file: attachment.fileName,
        sizeBytes: attachment.sizeBytes
      })),
      unavailableAttachmentIds: record.unavailableAttachmentIDs ?? [],
      files: {
        session: "session.json",
        messages: "messages.jsonl",
        attachments: attachmentFiles.map((attachment) => attachment.fileName)
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
      ),
      ...attachmentFiles.map((attachment) => ({
        agentSessionID: record.agentSessionID,
        archivePath: attachment.archivePath,
        content: attachment.content,
        path: `tuttid-attachment://${record.workspaceID}/${record.agentSessionID}/${attachment.attachmentID}`,
        provider: record.provider,
        sizeBytes: attachment.sizeBytes,
        workspaceID: record.workspaceID
      }))
    ];
  });
}

export async function loadDeveloperLogsAgentSessionAttachments(
  messages: readonly unknown[],
  readAttachment: (attachmentID: string) => Promise<{
    attachmentId: string;
    data: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    name?: string;
  }>
): Promise<{
  attachments: DeveloperLogsAgentSessionAttachment[];
  unavailableAttachmentIDs: string[];
}> {
  const references = collectImageAttachmentReferences(messages);
  const results = await Promise.all(
    references.map(
      async (
        reference
      ): Promise<
        | { attachment: DeveloperLogsAgentSessionAttachment }
        | { unavailableAttachmentID: string }
      > => {
        try {
          const attachment = await readAttachment(reference.attachmentID);
          return {
            attachment: {
              attachmentID: reference.attachmentID,
              dataBase64: attachment.data,
              mimeType: attachment.mimeType,
              ...((attachment.name ?? reference.name)
                ? { name: attachment.name ?? reference.name }
                : {})
            } satisfies DeveloperLogsAgentSessionAttachment
          };
        } catch {
          return { unavailableAttachmentID: reference.attachmentID };
        }
      }
    )
  );
  return {
    attachments: results.flatMap((result) =>
      "attachment" in result ? [result.attachment] : []
    ),
    unavailableAttachmentIDs: results.flatMap((result) =>
      "unavailableAttachmentID" in result
        ? [result.unavailableAttachmentID]
        : []
    )
  };
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

function collectImageAttachmentReferences(
  values: readonly unknown[]
): Array<{ attachmentID: string; name?: string }> {
  const references = new Map<string, { attachmentID: string; name?: string }>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!value || typeof value !== "object") return;
    const candidate = value as Record<string, unknown>;
    if (
      candidate.type === "image" &&
      typeof candidate.attachmentId === "string"
    ) {
      const attachmentID = candidate.attachmentId.trim();
      if (attachmentID && !references.has(attachmentID)) {
        const name =
          typeof candidate.name === "string" ? candidate.name.trim() : "";
        references.set(attachmentID, {
          attachmentID,
          ...(name ? { name } : {})
        });
      }
    }
    Object.values(candidate).forEach(visit);
  };
  values.forEach(visit);
  return [...references.values()];
}

function imageExtension(
  mimeType: DeveloperLogsAgentSessionAttachment["mimeType"]
): ".jpg" | ".png" | ".webp" | null {
  switch (mimeType) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/webp":
      return ".webp";
  }
}
