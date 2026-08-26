import type { DesktopLocale } from "../i18n/core/locale.ts";
import type { DesktopThemeAppearance } from "../theme/core.ts";
import type {
  AgentActivityComposerOptions,
  AgentActivitySessionSettings,
  AgentPromptContentBlock
} from "@tutti-os/agent-activity-core";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput
} from "@tutti-os/workspace-user-project/contracts";
import type {
  TuttiExternalAtQueryDirectoryInput,
  TuttiExternalAtQueryInput,
  TuttiExternalAtQueryResult,
  TuttiExternalAtResolveInput,
  TuttiExternalAtResolveResult
} from "@tutti-os/workspace-external-core/contracts";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";

export interface DesktopCaptureAgentOption {
  capabilities: {
    imageInput: boolean;
    workspaceReferences: boolean;
  };
  /** Authoritative options for this target and the currently selected cwd/settings. */
  composerOptions: AgentActivityComposerOptions | null;
  description?: string | null;
  id: string;
  iconUrl: string;
  name: string;
  provider: string;
}

export interface DesktopCaptureState {
  agents: DesktopCaptureAgentOption[];
  displayHeight: number;
  displayWidth: number;
  locale: DesktopLocale;
  screenshotDataUrl: string;
  themeAppearance: DesktopThemeAppearance;
  workspaceId: string;
}

export interface DesktopCaptureComposerOptions {
  agents: DesktopCaptureAgentOption[];
}

export type DesktopCaptureComposerSettings = Pick<
  AgentActivitySessionSettings,
  | "browserUse"
  | "model"
  | "permissionModeId"
  | "planMode"
  | "reasoningEffort"
  | "speed"
>;

export interface DesktopCaptureComposerOptionsInput {
  agentTargetId: string;
  cwd?: string | null;
  settings?: DesktopCaptureComposerSettings | null;
}

export interface DesktopCaptureSelectionInput {
  height: number;
  width: number;
  x: number;
  y: number;
}

export interface DesktopCaptureAttachment {
  dataBase64: string;
  dataUrl: string;
  displayName: string;
  height: number;
  mimeType: "image/png";
  width: number;
}

export interface DesktopCaptureSelectionResult extends DesktopCaptureComposerOptions {
  attachment: DesktopCaptureAttachment;
}

export interface DesktopCaptureSubmitInput {
  agentTargetId: string;
  content: AgentPromptContentBlock[];
  cwd?: string;
  displayPrompt?: string;
  settings?: DesktopCaptureComposerSettings;
}

export interface DesktopCaptureSubmitResult {
  agentSessionId: string;
}

/**
 * Explicit composer picks persisted into the canonical per-target
 * composer-defaults ledger through the workspace owner. Absent fields stay
 * untouched; null clears a field.
 */
export interface DesktopCaptureRememberComposerDefaultsInput {
  agentTargetId: string;
  defaults: {
    codexSaverMode?: boolean;
    rtkSaverMode?: boolean;
    model?: string | null;
    permissionModeId?: string | null;
    reasoningEffort?: string | null;
    speed?: string | null;
  };
}

export interface DesktopCaptureApi {
  cancel(): Promise<void>;
  getComposerOptions(
    input: DesktopCaptureComposerOptionsInput
  ): Promise<DesktopCaptureComposerOptions>;
  getState(): Promise<DesktopCaptureState>;
  queryMentions(
    input: TuttiExternalAtQueryInput
  ): Promise<TuttiExternalAtQueryResult[]>;
  queryMentionDirectory(
    input: TuttiExternalAtQueryDirectoryInput
  ): Promise<TuttiExternalAtQueryResult[]>;
  resolveMention(
    input: TuttiExternalAtResolveInput
  ): Promise<TuttiExternalAtResolveResult | null>;
  rememberComposerDefaults(
    input: DesktopCaptureRememberComposerDefaultsInput
  ): Promise<void>;
  select(
    input: DesktopCaptureSelectionInput
  ): Promise<DesktopCaptureSelectionResult>;
  selectFiles(): Promise<WorkspaceFileReference[]>;
  selectProjectDirectory(): Promise<{ path: string } | null>;
  submit(input: DesktopCaptureSubmitInput): Promise<DesktopCaptureSubmitResult>;
  userProjects: {
    list(): Promise<{ projects: WorkspaceUserProject[] }>;
    prepareSelection(
      input: WorkspaceUserProjectSelectionPreparationInput
    ): Promise<WorkspaceUserProjectSelectionPreparation>;
    use(input: { path: string }): Promise<WorkspaceUserProject>;
  };
}
