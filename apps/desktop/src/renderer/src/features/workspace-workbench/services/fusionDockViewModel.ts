import type {
  DesktopFusionWindowDescriptor,
  DesktopFusionWindowKind
} from "@shared/contracts/fusion.ts";
import type { TranslateFn } from "@renderer/i18n";
import type { FusionBackgroundResource } from "./fusionDockResourceModel.ts";
import type { FusionDockLauncher } from "./fusionDockLauncherModel.ts";

export type FusionSearchItem =
  | {
      id: string;
      kind: "launcher";
      label: string;
      launcher: FusionDockLauncher;
    }
  | {
      command: "settings";
      id: string;
      kind: "command";
      label: string;
    }
  | {
      id: string;
      kind: "window";
      label: string;
      window: DesktopFusionWindowDescriptor;
    }
  | {
      id: string;
      kind: "resource";
      label: string;
      resource: FusionBackgroundResource;
    };

export function createFusionSearchItems(input: {
  launchers: readonly FusionDockLauncher[];
  query: string;
  resources: readonly FusionBackgroundResource[];
  scope?: "all" | "background-tasks";
  settingsLabel: string;
  t: TranslateFn;
  windows: readonly DesktopFusionWindowDescriptor[];
  workspaceNameById: Readonly<Record<string, string>>;
}): FusionSearchItem[] {
  const normalizedQuery = input.query.trim().toLocaleLowerCase();
  const commandItems: FusionSearchItem[] = [
    ...input.launchers.map((launcher) => ({
      id: `launcher:${launcher.entry.id}`,
      kind: "launcher" as const,
      label: launcher.entry.label,
      launcher
    })),
    {
      command: "settings",
      id: "command:settings",
      kind: "command",
      label: input.settingsLabel
    }
  ];
  if (!normalizedQuery && input.scope !== "background-tasks") {
    return commandItems;
  }
  const resourceItems: FusionSearchItem[] = input.resources
    .filter(
      (resource) =>
        input.scope !== "background-tasks" ||
        resource.category === "background-task"
    )
    .map((resource) => ({
      id: `resource:${resource.workspaceId}:${resource.kind}:${resource.id}`,
      kind: "resource" as const,
      label: resource.title,
      resource
    }));
  const items: FusionSearchItem[] =
    input.scope === "background-tasks"
      ? resourceItems
      : [
          ...commandItems,
          ...input.windows.map((window) => ({
            id: `window:${window.windowInstanceId}`,
            kind: "window" as const,
            label: window.title ?? input.t(fusionKindLabelKey(window.kind)),
            window
          })),
          ...resourceItems
        ];
  if (!normalizedQuery) {
    return items;
  }
  return items.filter((item) => {
    const haystack =
      item.kind === "resource"
        ? `${item.label} ${item.resource.workspaceName} ${item.resource.subtitle ?? ""} ${item.resource.status} ${
            item.resource.category === "recoverable-session"
              ? input.t("workspace.fusion.recoverableSession")
              : input.t("workspace.fusion.backgroundTasks")
          }`
        : item.kind === "window"
          ? `${item.label} ${input.workspaceNameById[item.window.workspaceId] ?? item.window.workspaceId} ${input.t(fusionKindLabelKey(item.window.kind))}`
          : item.kind === "launcher"
            ? `${item.label} ${item.launcher.entry.id} ${item.launcher.entry.typeId} ${item.launcher.kind}`
            : `${item.label} ${item.command}`;
    return haystack.toLocaleLowerCase().includes(normalizedQuery);
  });
}

export function resolveFusionSearchEnterAction(input: {
  ctrlKey: boolean;
  metaKey: boolean;
}): "activate" | "new" {
  return input.metaKey || input.ctrlKey ? "new" : "activate";
}

export function shouldShowFusionWorkspaceContext(input: {
  currentWorkspaceId?: string;
  resources: readonly FusionBackgroundResource[];
  windows: readonly DesktopFusionWindowDescriptor[];
}): boolean {
  const workspaceIds = new Set<string>();
  const currentWorkspaceId = input.currentWorkspaceId?.trim() ?? "";
  for (const window of input.windows) {
    const workspaceId = window.workspaceId.trim();
    if (workspaceId) {
      workspaceIds.add(workspaceId);
    }
  }
  for (const resource of input.resources) {
    const workspaceId = resource.workspaceId.trim();
    if (workspaceId) {
      workspaceIds.add(workspaceId);
    }
  }
  return (
    workspaceIds.size > 1 ||
    (currentWorkspaceId !== "" &&
      [...workspaceIds].some(
        (workspaceId) => workspaceId !== currentWorkspaceId
      ))
  );
}

export function fusionKindLabelKey(kind: DesktopFusionWindowKind) {
  switch (kind) {
    case "agent":
      return "workspace.fusion.kind.agent" as const;
    case "terminal":
      return "workspace.fusion.kind.terminal" as const;
    case "browser":
      return "workspace.fusion.kind.browser" as const;
    case "files":
      return "workspace.fusion.kind.files" as const;
    case "file-preview":
      return "workspace.fusion.kind.filePreview" as const;
    case "workspace-app":
      return "workspace.fusion.kind.workspaceApp" as const;
    case "app-center":
      return "workspace.fusion.kind.appCenter" as const;
    case "settings":
      return "workspace.fusion.kind.settings" as const;
    case "issue-manager":
      return "workspace.fusion.kind.issueManager" as const;
  }
}
