import type {
  WorkspaceAgentSession,
  WorkspaceApp,
  WorkspaceTerminalSession
} from "@tutti-os/client-tuttid-ts";
import type {
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";

export type FusionBackgroundResourceKind = Extract<
  DesktopFusionWindowKind,
  "agent" | "terminal" | "workspace-app"
>;

export type FusionDockResourceCategory =
  | "background-task"
  | "recoverable-session";

export interface FusionBackgroundResource {
  attachedWindowCount: number;
  canStop: boolean;
  category: FusionDockResourceCategory;
  id: string;
  kind: FusionBackgroundResourceKind;
  provider: string | null;
  status: string;
  subtitle: string | null;
  title: string;
  updatedAtUnixMs: number;
  workspaceId: string;
  workspaceName: string;
}

export function projectFusionBackgroundResources(input: {
  agentSessions: readonly WorkspaceAgentSession[];
  apps: readonly WorkspaceApp[];
  terminals: readonly WorkspaceTerminalSession[];
  windows: readonly DesktopFusionWindowDescriptor[];
  workspaceId: string;
  workspaceName: string;
}): FusionBackgroundResource[] {
  const resources: FusionBackgroundResource[] = [];

  for (const session of input.agentSessions) {
    if (
      !session.visible ||
      (!isActiveAgentStatus(session.status) && !session.resumable)
    ) {
      continue;
    }
    resources.push({
      attachedWindowCount: countResourceWindows(
        input.windows,
        "agent",
        session.id,
        input.workspaceId
      ),
      canStop: session.status === "running" || session.status === "waiting",
      category: isActiveAgentStatus(session.status)
        ? "background-task"
        : "recoverable-session",
      id: session.id,
      kind: "agent",
      provider: session.provider,
      status: session.status,
      subtitle: session.cwd ?? session.provider,
      title: session.title?.trim() || session.provider,
      updatedAtUnixMs: Date.parse(session.updatedAt ?? session.createdAt) || 0,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName
    });
  }

  for (const terminal of input.terminals) {
    if (!isBackgroundTerminalStatus(terminal.status)) {
      continue;
    }
    resources.push({
      attachedWindowCount: countResourceWindows(
        input.windows,
        "terminal",
        terminal.id,
        input.workspaceId
      ),
      canStop: true,
      category: "background-task",
      id: terminal.id,
      kind: "terminal",
      provider: null,
      status: terminal.status,
      subtitle: terminal.cwd,
      title: terminal.title,
      updatedAtUnixMs:
        Date.parse(terminal.updatedAt ?? terminal.createdAt) || 0,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName
    });
  }

  for (const app of input.apps) {
    if (!isBackgroundAppStatus(app.status)) {
      continue;
    }
    resources.push({
      attachedWindowCount: countResourceWindows(
        input.windows,
        "workspace-app",
        app.appId,
        input.workspaceId
      ),
      canStop: app.status !== "stopping",
      category: "background-task",
      id: app.appId,
      kind: "workspace-app",
      provider: null,
      status: app.status,
      subtitle: app.version,
      title: app.displayName,
      updatedAtUnixMs: app.updatedAtUnixMs ?? app.startedAtUnixMs ?? 0,
      workspaceId: input.workspaceId,
      workspaceName: input.workspaceName
    });
  }

  return [...resources].sort(
    (left, right) =>
      right.updatedAtUnixMs - left.updatedAtUnixMs ||
      left.title.localeCompare(right.title)
  );
}

function countResourceWindows(
  windows: readonly DesktopFusionWindowDescriptor[],
  kind: FusionBackgroundResourceKind,
  resourceId: string,
  workspaceId: string
): number {
  return windows.filter(
    (window) =>
      window.kind === kind &&
      window.resourceId === resourceId &&
      window.workspaceId === workspaceId
  ).length;
}

function isActiveAgentStatus(status: WorkspaceAgentSession["status"]): boolean {
  return status === "created" || status === "running" || status === "waiting";
}

function isBackgroundTerminalStatus(
  status: WorkspaceTerminalSession["status"]
): boolean {
  return (
    status === "created" ||
    status === "starting" ||
    status === "running" ||
    status === "detached"
  );
}

function isBackgroundAppStatus(status: WorkspaceApp["status"]): boolean {
  return (
    status === "preparing" ||
    status === "starting" ||
    status === "running" ||
    status === "installed_pending_restart" ||
    status === "stopping"
  );
}
