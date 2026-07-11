import type {
  TuttiExternalAtProviderId,
  TuttiExternalCapabilities,
  TuttiExternalManagedAiModelProviderId,
  TuttiExternalOperation,
  TuttiExternalWorkspaceAgentProvider,
  TuttiExternalWorkspaceFeature
} from "../../contracts/index.ts";

const stable26Operations = Object.freeze([
  "app.getContext",
  "app.subscribe",
  "activity.reportActive",
  "browser.openUrl",
  "at.query",
  "files.select",
  "files.open",
  "files.upload",
  "permissions.request",
  "settings.open",
  "workspace.onLaunchIntent",
  "workspace.openFeature",
  "references.open",
  "pdf.printHtmlToPdf",
  "userProjects.checkPath",
  "userProjects.create",
  "userProjects.getDefaultSelection",
  "userProjects.getSnapshot",
  "userProjects.list",
  "userProjects.prepareSelection",
  "userProjects.refresh",
  "userProjects.rememberDefaultSelection",
  "userProjects.selectDirectory",
  "userProjects.subscribe",
  "userProjects.use",
  "logs.write"
] as const satisfies readonly TuttiExternalOperation[]);

const stable26AtProviders = Object.freeze([
  "file",
  "workspace-issue",
  "workspace-app",
  "agent-target",
  "agent-session",
  "agent-generated-file"
] as const satisfies readonly TuttiExternalAtProviderId[]);

const stable26WorkspaceFeatures = Object.freeze([
  "app-center",
  "issue-manager",
  "message-center",
  "agent-connect",
  "agent-chat",
  "agent-manage"
] as const satisfies readonly TuttiExternalWorkspaceFeature[]);

const stable26WorkspaceAgentProviders = Object.freeze([
  "claude-code",
  "codex",
  "cursor",
  "nexight",
  "hermes",
  "openclaw"
] as const satisfies readonly TuttiExternalWorkspaceAgentProvider[]);

const stable26ManagedAiProviders = Object.freeze([
  "agnes",
  "openai",
  "anthropic"
] as const satisfies readonly TuttiExternalManagedAiModelProviderId[]);

/** The non-configurable capability profile required for a stable host. */
export const tuttiExternalStable26ConformanceProfile = Object.freeze({
  id: "stable26",
  activationOperations: Object.freeze([
    "browser.openUrl",
    "files.select",
    "files.open",
    "permissions.request",
    "settings.open",
    "workspace.openFeature",
    "references.open",
    "pdf.printHtmlToPdf",
    "userProjects.create",
    "userProjects.selectDirectory"
  ] as const satisfies readonly TuttiExternalOperation[]),
  capabilities: Object.freeze({
    operations: stable26Operations,
    atProviders: stable26AtProviders,
    workspaceFeatures: stable26WorkspaceFeatures,
    workspaceAgentProviders: stable26WorkspaceAgentProviders,
    managedAiProviders: stable26ManagedAiProviders
  })
}) satisfies Readonly<{
  activationOperations: readonly TuttiExternalOperation[];
  capabilities: TuttiExternalCapabilities;
  id: "stable26";
}>;

/** The exact immutable shape of the stable26 capability profile. */
export type TuttiExternalStable26ConformanceProfile =
  typeof tuttiExternalStable26ConformanceProfile;
