// Pure decision logic for ExternalAgentSessionImportWizard.tsx, split out so
// it can be unit tested without mounting the dialog (this app's test runner
// is plain node:test over *.test.ts and has no React rendering harness).

import type {
  ExternalAgentImportArchiveKind,
  ExternalAgentImportScanRequest,
  ExternalAgentImportScanResponse,
  ExternalAgentImportSession,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";

export type ExternalImportProjectGroup = {
  path: string;
  label: string;
  providers: WorkspaceAgentProvider[];
  sessions: ExternalAgentImportSession[];
};

export type ExternalImportScanSource =
  | {
      kind: "archive";
      archivePath: string;
      archiveKind: ExternalAgentImportArchiveKind;
    }
  | {
      kind: "local";
      providers: WorkspaceAgentProvider[];
    };

export type ExternalImportScanCatalog = {
  anchorUnixMs: number;
  response: ExternalAgentImportScanResponse;
  source: ExternalImportScanSource;
};

export type ExternalImportScanState = ExternalImportScanCatalog | null;

export type ExternalImportScanStateAction =
  | { type: "scan-started" }
  | { type: "scan-failed" }
  | { type: "source-changed" }
  | {
      type: "scan-succeeded";
      anchorUnixMs: number;
      response: ExternalAgentImportScanResponse;
      source: ExternalImportScanSource;
    };

export function isExternalImportArchiveMode(
  archivePath: string | null | undefined
): boolean {
  return Boolean(archivePath?.trim());
}

export function externalImportScanSource({
  archiveKind,
  archivePath,
  providers
}: {
  archiveKind: ExternalAgentImportArchiveKind;
  archivePath: string | null;
  providers: WorkspaceAgentProvider[];
}): ExternalImportScanSource {
  const normalizedArchivePath = archivePath?.trim();
  if (normalizedArchivePath) {
    return {
      kind: "archive",
      archivePath: normalizedArchivePath,
      archiveKind
    };
  }
  return {
    kind: "local",
    providers: [...new Set(providers)].sort(compareExternalImportStrings)
  };
}

export function externalImportScanRequest(
  source: ExternalImportScanSource
): ExternalAgentImportScanRequest {
  return source.kind === "archive"
    ? {
        archivePath: source.archivePath,
        archiveKind: source.archiveKind,
        days: -1
      }
    : { days: -1, providers: source.providers };
}

export function externalImportScanStateReducer(
  _current: ExternalImportScanState,
  action: ExternalImportScanStateAction
): ExternalImportScanState {
  if (action.type === "scan-succeeded") {
    return {
      anchorUnixMs: action.anchorUnixMs,
      response: action.response,
      source: action.source
    };
  }
  return null;
}

export function externalImportUsableScanCatalog(
  state: ExternalImportScanState,
  source: ExternalImportScanSource
): ExternalImportScanCatalog | null {
  return state && externalImportScanSourcesEqual(state.source, source)
    ? state
    : null;
}

function externalImportScanSourcesEqual(
  left: ExternalImportScanSource,
  right: ExternalImportScanSource
): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "archive" && right.kind === "archive") {
    return (
      left.archivePath === right.archivePath &&
      left.archiveKind === right.archiveKind
    );
  }
  if (left.kind === "local" && right.kind === "local") {
    return (
      left.providers.length === right.providers.length &&
      left.providers.every(
        (provider, index) => provider === right.providers[index]
      )
    );
  }
  return false;
}

const externalImportDayMs = 24 * 60 * 60 * 1000;

export function projectExternalImportScan(
  catalog: ExternalAgentImportScanResponse,
  days: number,
  anchorUnixMs: number
): ExternalAgentImportScanResponse {
  const effectiveDays = days === 0 ? 30 : days;
  const cutoffUnixMs =
    effectiveDays < 0 ? 0 : anchorUnixMs - effectiveDays * externalImportDayMs;
  const sessions = catalog.sessions.filter(
    (session) => (session.lastUpdatedAtUnixMs ?? 0) >= cutoffUnixMs
  );
  const catalogProjects = new Map(
    catalog.projects.map((project) => [project.path, project])
  );
  const projectCounts = new Map<
    string,
    {
      label: string;
      lastUpdatedAtUnixMs: number;
      messageCount: number;
      providers: Set<WorkspaceAgentProvider>;
      sessionCount: number;
    }
  >();
  const providerCounts = new Map<
    WorkspaceAgentProvider,
    { messageCount: number; sessionCount: number }
  >();
  let scannedMessages = 0;

  for (const session of sessions) {
    const updatedAtUnixMs = session.lastUpdatedAtUnixMs ?? 0;
    scannedMessages += session.messageCount;

    const provider = providerCounts.get(session.provider) ?? {
      messageCount: 0,
      sessionCount: 0
    };
    provider.messageCount += session.messageCount;
    provider.sessionCount += 1;
    providerCounts.set(session.provider, provider);

    const project = projectCounts.get(session.projectPath) ?? {
      label:
        catalogProjects.get(session.projectPath)?.label ?? session.projectPath,
      lastUpdatedAtUnixMs: 0,
      messageCount: 0,
      providers: new Set<WorkspaceAgentProvider>(),
      sessionCount: 0
    };
    project.lastUpdatedAtUnixMs = Math.max(
      project.lastUpdatedAtUnixMs,
      updatedAtUnixMs
    );
    project.messageCount += session.messageCount;
    project.providers.add(session.provider);
    project.sessionCount += 1;
    projectCounts.set(session.projectPath, project);
  }

  const projects = [...projectCounts.entries()]
    .map(([path, project]) => ({
      path,
      label: project.label,
      providers: [...project.providers].sort(compareExternalImportStrings),
      sessionCount: project.sessionCount,
      messageCount: project.messageCount,
      lastUpdatedAtUnixMs: project.lastUpdatedAtUnixMs
    }))
    .sort((left, right) => {
      if (left.lastUpdatedAtUnixMs === right.lastUpdatedAtUnixMs) {
        return compareExternalImportStrings(left.path, right.path);
      }
      return right.lastUpdatedAtUnixMs - left.lastUpdatedAtUnixMs;
    });

  return {
    ...catalog,
    providers: catalog.providers.map((provider) => {
      const counts = providerCounts.get(provider.provider);
      return {
        ...provider,
        sessionCount: counts?.sessionCount ?? 0,
        messageCount: counts?.messageCount ?? 0
      };
    }),
    projects,
    sessions,
    scannedSessions: sessions.length,
    scannedMessages
  };
}

function compareExternalImportStrings(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

export function externalImportRequestSource(
  archivePath: string | null,
  archiveKind: ExternalAgentImportArchiveKind | null,
  registerProjects: boolean
): {
  archivePath?: string;
  archiveKind?: ExternalAgentImportArchiveKind;
  registerUserProjects: boolean;
} {
  const normalizedArchivePath = archivePath?.trim();
  if (!normalizedArchivePath) {
    return { registerUserProjects: registerProjects };
  }
  return {
    archivePath: normalizedArchivePath,
    ...(archiveKind ? { archiveKind } : {}),
    registerUserProjects: false
  };
}

/**
 * The import wizard is "busy" whenever a scan or import request is in
 * flight. Dismissing the dialog does not cancel that request (there is no
 * AbortController wired up; the backend keeps running to completion either
 * way), but a disappearing dialog reads as "the import stopped". All three
 * ways a Radix Dialog can be dismissed - Escape, click-outside, and the
 * built-in "X" close button - must agree on this single condition so none
 * of them can slip through while busy.
 */
export function isExternalImportWizardBusy({
  importing,
  loading
}: {
  importing: boolean;
  loading: boolean;
}): boolean {
  return loading || importing;
}

/**
 * Decides whether a Dialog onOpenChange(nextOpen) call should be allowed
 * through. Only closes (nextOpen === false) are ever blocked, and only
 * while busy; opening, and any change once idle, is always allowed.
 */
export function shouldAllowExternalImportDialogOpenChange({
  importing,
  loading,
  nextOpen
}: {
  importing: boolean;
  loading: boolean;
  nextOpen: boolean;
}): boolean {
  if (nextOpen) {
    return true;
  }
  return !isExternalImportWizardBusy({ importing, loading });
}

export function externalImportGroupsFromScan(
  scan: ExternalAgentImportScanResponse | null,
  projectLabelFallback: (path: string) => string,
  labelOverride?: string
): ExternalImportProjectGroup[] {
  if (!scan) {
    return [];
  }
  const labelByPath = new Map(
    scan.projects.map((project) => [project.path, project.label])
  );
  const groupByPath = new Map<string, ExternalImportProjectGroup>();
  for (const session of scan.sessions) {
    const path = session.projectPath;
    let group = groupByPath.get(path);
    if (!group) {
      group = {
        path,
        label:
          labelOverride ?? labelByPath.get(path) ?? projectLabelFallback(path),
        providers: [],
        sessions: []
      };
      groupByPath.set(path, group);
    }
    if (!group.providers.includes(session.provider)) {
      group.providers.push(session.provider);
    }
    group.sessions.push(session);
  }
  return [...groupByPath.values()].sort(
    (left, right) =>
      externalImportGroupRecency(right) - externalImportGroupRecency(left)
  );
}

function externalImportGroupRecency(group: ExternalImportProjectGroup): number {
  return group.sessions.reduce(
    (latest, session) => Math.max(latest, session.lastUpdatedAtUnixMs ?? 0),
    0
  );
}

export function filterExternalImportGroups(
  groups: ExternalImportProjectGroup[],
  search: string
): ExternalImportProjectGroup[] {
  const query = search.trim().toLowerCase();
  if (!query) {
    return groups;
  }
  const result: ExternalImportProjectGroup[] = [];
  for (const group of groups) {
    const labelMatch =
      group.label.toLowerCase().includes(query) ||
      group.path.toLowerCase().includes(query);
    const sessions = labelMatch
      ? group.sessions
      : group.sessions.filter((session) =>
          session.title.toLowerCase().includes(query)
        );
    if (sessions.length > 0) {
      result.push({ ...group, sessions });
    }
  }
  return result;
}

export function externalImportSelectionProjects(
  sessions: ExternalAgentImportSession[],
  deselectedSessionIds: Set<string>
): {
  path: string;
  providers?: WorkspaceAgentProvider[];
  sessionIds?: string[];
}[] {
  const byPath = new Map<
    string,
    {
      path: string;
      providers: Set<WorkspaceAgentProvider>;
      sessionIds: string[];
    }
  >();
  for (const session of sessions) {
    if (deselectedSessionIds.has(session.id)) {
      continue;
    }
    let entry = byPath.get(session.projectPath);
    if (!entry) {
      entry = {
        path: session.projectPath,
        providers: new Set(),
        sessionIds: []
      };
      byPath.set(session.projectPath, entry);
    }
    entry.providers.add(session.provider);
    entry.sessionIds.push(session.id);
  }
  return [...byPath.values()].map((entry) => ({
    path: entry.path,
    providers: [...entry.providers],
    sessionIds: entry.sessionIds
  }));
}
