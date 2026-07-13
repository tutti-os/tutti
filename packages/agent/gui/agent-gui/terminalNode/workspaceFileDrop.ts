const WORKSPACE_FILE_DROP_MIME_TYPE =
  "application/x-tsh-workspace-file-paths+json";

export type WorkspaceFileDropEntryKind = "file" | "directory" | "unknown";

export interface WorkspaceFileDropEntry {
  path: string;
  name: string;
  kind: WorkspaceFileDropEntryKind;
}

interface WorkspaceFileDropPayload {
  entries?: unknown;
}

function normalizeWorkspaceFileDropEntryKind(
  kind: unknown
): WorkspaceFileDropEntryKind {
  return kind === "file" || kind === "directory" ? kind : "unknown";
}

function basenameWorkspacePath(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+$/g, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments.at(-1) ?? normalized;
}

function normalizeWorkspaceFileDropEntries(
  entries: readonly WorkspaceFileDropEntry[]
): WorkspaceFileDropEntry[] {
  const uniquePaths = new Set<string>();
  const normalizedEntries: WorkspaceFileDropEntry[] = [];
  for (const entry of entries) {
    const path = entry.path.trim();
    if (!path || uniquePaths.has(path)) {
      continue;
    }
    uniquePaths.add(path);
    normalizedEntries.push({
      path,
      name: entry.name.trim() || basenameWorkspacePath(path),
      kind: normalizeWorkspaceFileDropEntryKind(entry.kind)
    });
  }
  return normalizedEntries;
}

function normalizeWorkspaceFileDropPaths(paths: readonly string[]): string[] {
  return normalizeWorkspaceFileDropEntries(
    paths.map((path) => ({
      path,
      name: basenameWorkspacePath(path),
      kind: "unknown"
    }))
  ).map((entry) => entry.path);
}

export function writeWorkspaceFileDropData(
  dataTransfer: DataTransfer,
  entries: readonly WorkspaceFileDropEntry[]
): void {
  if (entries.length === 0) {
    return;
  }
  const normalizedEntries = normalizeWorkspaceFileDropEntries(entries);
  if (normalizedEntries.length === 0) {
    return;
  }
  const normalizedPaths = normalizedEntries.map((entry) => entry.path);
  dataTransfer.effectAllowed = "copy";
  dataTransfer.setData(
    WORKSPACE_FILE_DROP_MIME_TYPE,
    JSON.stringify({ entries: normalizedEntries })
  );
  dataTransfer.setData("text/plain", normalizedPaths.join("\n"));
}

export function hasWorkspaceFileDropData(
  dataTransfer: DataTransfer | null | undefined
): boolean {
  if (!dataTransfer) {
    return false;
  }
  return Array.from(dataTransfer.types ?? []).includes(
    WORKSPACE_FILE_DROP_MIME_TYPE
  );
}

export function readWorkspaceFileDropPaths(
  dataTransfer: DataTransfer | null | undefined
): string[] {
  return readWorkspaceFileDropEntries(dataTransfer).map((entry) => entry.path);
}

export function readWorkspaceFileDropEntries(
  dataTransfer: DataTransfer | null | undefined
): WorkspaceFileDropEntry[] {
  if (!hasWorkspaceFileDropData(dataTransfer)) {
    return [];
  }
  const raw = dataTransfer?.getData(WORKSPACE_FILE_DROP_MIME_TYPE).trim() ?? "";
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as WorkspaceFileDropPayload;
    if (Array.isArray(parsed.entries)) {
      return normalizeWorkspaceFileDropEntries(
        parsed.entries.flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }
          const path =
            "path" in entry && typeof entry.path === "string" ? entry.path : "";
          const name =
            "name" in entry && typeof entry.name === "string" ? entry.name : "";
          const kind = "kind" in entry ? entry.kind : "unknown";
          return [
            { path, name, kind: normalizeWorkspaceFileDropEntryKind(kind) }
          ];
        })
      );
    }
    return [];
  } catch {
    return [];
  }
}

export function quoteWorkspacePathForTerminal(path: string): string {
  return `'${path.replace(/'/g, `'"'"'`)}'`;
}

export function buildWorkspaceFileDropTerminalInput(
  paths: readonly string[]
): string {
  const normalizedPaths = normalizeWorkspaceFileDropPaths(paths);
  if (normalizedPaths.length === 0) {
    return "";
  }
  return `${normalizedPaths.map((path) => quoteWorkspacePathForTerminal(path)).join(" ")} `;
}
