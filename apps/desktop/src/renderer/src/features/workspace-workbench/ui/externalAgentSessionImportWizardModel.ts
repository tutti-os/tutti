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
      days: number;
    }
  | {
      kind: "local";
      days: number;
      providers: WorkspaceAgentProvider[];
    };

export type ExternalImportScanState = {
  response: ExternalAgentImportScanResponse;
  source: ExternalImportScanSource;
} | null;

export type ExternalImportScanStateAction =
  | { type: "scan-started" }
  | { type: "scan-failed" }
  | { type: "source-changed" }
  | {
      type: "scan-succeeded";
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
  days,
  providers
}: {
  archiveKind: ExternalAgentImportArchiveKind;
  archivePath: string | null;
  days: number;
  providers: WorkspaceAgentProvider[];
}): ExternalImportScanSource {
  const normalizedArchivePath = archivePath?.trim();
  if (normalizedArchivePath) {
    return {
      kind: "archive",
      archivePath: normalizedArchivePath,
      archiveKind,
      days
    };
  }
  return {
    kind: "local",
    days,
    providers: [...new Set(providers)]
  };
}

export function externalImportScanRequest(
  source: ExternalImportScanSource
): ExternalAgentImportScanRequest {
  return source.kind === "archive"
    ? {
        archivePath: source.archivePath,
        archiveKind: source.archiveKind,
        days: source.days
      }
    : { days: source.days, providers: source.providers };
}

export function externalImportScanStateReducer(
  _current: ExternalImportScanState,
  action: ExternalImportScanStateAction
): ExternalImportScanState {
  if (action.type === "scan-succeeded") {
    return { response: action.response, source: action.source };
  }
  return null;
}

export function externalImportUsableScan(
  state: ExternalImportScanState,
  source: ExternalImportScanSource
): ExternalAgentImportScanResponse | null {
  return state && externalImportScanSourcesEqual(state.source, source)
    ? state.response
    : null;
}

function externalImportScanSourcesEqual(
  left: ExternalImportScanSource,
  right: ExternalImportScanSource
): boolean {
  if (left.kind !== right.kind || left.days !== right.days) {
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
      left.providers.every((provider) => right.providers.includes(provider))
    );
  }
  return false;
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
