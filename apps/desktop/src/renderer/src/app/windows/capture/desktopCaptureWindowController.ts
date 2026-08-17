import type {
  DesktopCaptureApi,
  DesktopCaptureAttachment,
  DesktopCaptureComposerSettings,
  DesktopCaptureSelectionInput,
  DesktopCaptureState
} from "../../../../../shared/contracts/capture.ts";
import { resolveCaptureAgentCapabilities } from "../../../../../shared/capture/captureAgentCapabilities.ts";
import type { AgentPromptContentBlock } from "@tutti-os/agent-activity-core";
import {
  ComposerSettingsCore,
  type ComposerSettingsCoreSnapshot,
  type ComposerSettingsDraft
} from "@tutti-os/agent-gui/composer-settings-core";
import type { TuttiExternalAtRichTextBridge } from "@tutti-os/workspace-external-core/rich-text";
import type { WorkspaceFileReference } from "@tutti-os/workspace-file-reference/contracts";
import type { WorkspaceUserProjectApi } from "@tutti-os/workspace-user-project/contracts";
import type { DesktopCaptureAgentTargetPreference } from "./desktopCaptureAgentTargetPreference.ts";
import type { DesktopCaptureProjectPreference } from "./desktopCaptureProjectPreference.ts";

export type DesktopCaptureStage =
  | "loading"
  | "selecting"
  | "preparing"
  | "composing";

export interface DesktopCaptureWindowSnapshot {
  attachment: DesktopCaptureAttachment | null;
  agentTargetId: string;
  capture: DesktopCaptureState | null;
  composerSettings: DesktopCaptureComposerSettings;
  content: AgentPromptContentBlock[];
  failed: boolean;
  projectPath: string | null;
  refreshingAgentOptions: boolean;
  selection: DesktopCaptureSelectionInput | null;
  selectionPending: boolean;
  stage: DesktopCaptureStage;
  submitting: boolean;
  trackWithTask: boolean;
}

const initialSnapshot: DesktopCaptureWindowSnapshot = {
  attachment: null,
  agentTargetId: "",
  capture: null,
  composerSettings: {},
  content: [],
  failed: false,
  projectPath: null,
  refreshingAgentOptions: false,
  selection: null,
  selectionPending: false,
  stage: "loading",
  submitting: false,
  trackWithTask: false
};

export class DesktopCaptureWindowController {
  private readonly api: DesktopCaptureApi;
  private readonly agentTargetPreference: DesktopCaptureAgentTargetPreference | null;
  private readonly projectPreference: DesktopCaptureProjectPreference | null;
  private readonly settingsCore: ComposerSettingsCore;
  private dragStart: { x: number; y: number } | null = null;
  private initializePromise: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();
  private selectionPromise: Promise<boolean> | null = null;
  private snapshot = initialSnapshot;
  /** Base state without core-derived fields; merged on every emit. */
  private base = initialSnapshot;
  readonly mentionBridge: TuttiExternalAtRichTextBridge;
  readonly userProjectApi: WorkspaceUserProjectApi;

  constructor(
    api: DesktopCaptureApi,
    agentTargetPreference: DesktopCaptureAgentTargetPreference | null = null,
    projectPreference: DesktopCaptureProjectPreference | null = null
  ) {
    this.api = api;
    this.agentTargetPreference = agentTargetPreference;
    this.projectPreference = projectPreference;
    // Settings policy (draft, fenced options lifecycle, defaults write-back)
    // lives in the shared core; this controller keeps only capture lifecycle
    // and window-local presentation state.
    this.settingsCore = new ComposerSettingsCore(
      {
        fetchOptions: async ({ agentTargetId, cwd, settings }) => {
          const result = await this.api.getComposerOptions({
            agentTargetId,
            cwd,
            settings:
              settings && Object.keys(settings).length > 0 ? settings : null
          });
          const agent = result.agents.find(
            (candidate) => candidate.id === agentTargetId
          );
          if (!agent?.composerOptions) {
            throw new Error("Selected screenshot Agent target is unavailable");
          }
          // No side effects here: capabilities derive from the fenced core
          // options in mergeSnapshot, so a stale response can never leak a
          // stale capability verdict past the fence.
          return agent.composerOptions;
        },
        rememberDefaults: async (agentTargetId, patch) => {
          const defaults = composerDefaultsPatchFromDraft(patch);
          if (Object.keys(defaults).length === 0) {
            return;
          }
          await this.api.rememberComposerDefaults({ agentTargetId, defaults });
        }
      },
      { agentTargetId: "", cwd: null }
    );
    this.settingsCore.subscribe(() => this.emit());
    this.mentionBridge = {
      at: {
        query: (input) => this.api.queryMentions(input),
        queryDirectory: (input) => this.api.queryMentionDirectory(input),
        resolve: (input) => this.api.resolveMention(input)
      }
    };
    this.userProjectApi = {
      list: () => this.api.userProjects.list(),
      prepareSelection: (input) =>
        this.api.userProjects.prepareSelection(input),
      selectDirectory: () => this.api.selectProjectDirectory(),
      use: (input) => this.api.userProjects.use(input)
    };
  }

  readonly getSnapshot = (): DesktopCaptureWindowSnapshot => this.snapshot;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  initialize(): Promise<void> {
    this.initializePromise ??= this.api
      .getState()
      .then((capture) => {
        this.update({
          agentTargetId:
            this.agentTargetPreference?.read(capture.workspaceId) ?? "",
          capture,
          failed: false,
          projectPath:
            this.projectPreference?.read(capture.workspaceId) ?? null,
          stage: "selecting"
        });
      })
      .catch(() => this.update({ failed: true }));
    return this.initializePromise;
  }

  beginSelection(point: { x: number; y: number }): void {
    if (this.snapshot.stage !== "selecting" || this.snapshot.selectionPending) {
      return;
    }
    this.dragStart = point;
    this.update({
      failed: false,
      selection: { ...point, height: 0, width: 0 }
    });
  }

  updateSelection(point: { x: number; y: number }): void {
    if (this.snapshot.selectionPending) {
      return;
    }
    const start = this.dragStart;
    if (!start) {
      return;
    }
    this.update({
      selection: {
        x: Math.min(start.x, point.x),
        y: Math.min(start.y, point.y),
        width: Math.abs(point.x - start.x),
        height: Math.abs(point.y - start.y)
      }
    });
  }

  finishSelection(): Promise<boolean> {
    if (this.selectionPromise) {
      return this.selectionPromise;
    }
    if (this.snapshot.stage !== "selecting") {
      return Promise.resolve(false);
    }
    const selection = this.snapshot.selection;
    this.dragStart = null;
    if (!selection || selection.width < 8 || selection.height < 8) {
      this.update({ selection: null });
      return Promise.resolve(false);
    }
    this.update({
      failed: false,
      selectionPending: true,
      stage: "preparing"
    });
    const selectionPromise = this.completeSelection(selection).finally(() => {
      if (this.selectionPromise === selectionPromise) {
        this.selectionPromise = null;
      }
    });
    this.selectionPromise = selectionPromise;
    return selectionPromise;
  }

  private async completeSelection(
    selection: DesktopCaptureSelectionInput
  ): Promise<boolean> {
    try {
      const result = await this.api.select(selection);
      const capture = this.base.capture;
      if (!capture) {
        this.update({ selectionPending: false });
        return false;
      }
      const agentTargetId = resolveAvailableAgentTargetId(
        result.agents,
        this.snapshot.agentTargetId
      );
      this.update({
        agentTargetId,
        attachment: result.attachment,
        capture: {
          ...capture,
          agents: result.agents
        },
        content: [
          { text: "", type: "text" },
          {
            data: result.attachment.dataBase64,
            mimeType: result.attachment.mimeType,
            name: result.attachment.displayName,
            type: "image"
          }
        ],
        failed: false,
        selectionPending: false,
        stage: "composing"
      });
      // The core context starts empty, so this transition always issues the
      // first with-context options fetch for the selected target.
      this.settingsCore.setContext({
        agentTargetId,
        cwd: this.snapshot.projectPath
      });
      return true;
    } catch {
      this.update({ failed: true, selectionPending: false });
      return false;
    }
  }

  cancelSelection(): void {
    if (!this.snapshot.submitting) {
      void this.api.cancel();
    }
  }

  setAgentTargetId(agentTargetId: string): void {
    const capture = this.base.capture;
    if (!capture?.agents.some((agent) => agent.id === agentTargetId)) {
      return;
    }
    this.agentTargetPreference?.write(capture.workspaceId, agentTargetId);
    this.update({ agentTargetId });
    this.settingsCore.setContext({
      agentTargetId,
      cwd: this.snapshot.projectPath
    });
  }

  setContent(content: AgentPromptContentBlock[]): void {
    this.update({ content });
  }

  setTrackWithTask(trackWithTask: boolean): void {
    this.update({ trackWithTask });
  }

  setComposerSettings(patch: DesktopCaptureComposerSettings): void {
    if (this.snapshot.submitting) {
      return;
    }
    this.settingsCore.setSettings(patch);
  }

  selectFiles(): Promise<readonly WorkspaceFileReference[]> {
    return this.api.selectFiles();
  }

  readonly setProjectPath = async (
    projectPath: string | null
  ): Promise<void> => {
    const capture = this.base.capture;
    const normalizedProjectPath = projectPath?.trim() || null;
    if (!capture) {
      return;
    }
    this.projectPreference?.write(capture.workspaceId, normalizedProjectPath);
    this.update({ projectPath: normalizedProjectPath });
    this.settingsCore.setContext({
      agentTargetId: this.snapshot.agentTargetId,
      cwd: normalizedProjectPath
    });
  };

  async submit(
    agentTargetId: string,
    content: AgentPromptContentBlock[] = this.snapshot.content,
    displayPrompt?: string,
    taskInstruction?: string
  ): Promise<void> {
    const {
      agentTargetId: selectedAgentTargetId,
      attachment,
      projectPath,
      submitting,
      trackWithTask
    } = this.snapshot;
    if (
      !attachment ||
      !agentTargetId ||
      agentTargetId !== selectedAgentTargetId ||
      !this.snapshot.capture?.agents.some(
        (agent) => agent.id === agentTargetId && agent.capabilities.imageInput
      ) ||
      submitting ||
      content.length === 0
    ) {
      return;
    }
    this.update({ content, failed: false, submitting: true });
    try {
      const visiblePrompt =
        displayPrompt?.trim() || capturePromptText(content).trim();
      // Submit exactly what the composer displays: the core resolves the
      // draft over the loaded effective settings, so the daemon never has to
      // re-interpret empty fields against another surface's memory.
      const settings = this.settingsCore.resolveSubmitSettings();
      await this.api.submit({
        agentTargetId,
        content: trackWithTask
          ? prependCapturePromptInstruction(content, taskInstruction)
          : content,
        ...(projectPath ? { cwd: projectPath } : {}),
        ...(visiblePrompt ? { displayPrompt: visiblePrompt } : {}),
        ...(Object.keys(settings).length > 0 ? { settings } : {})
      });
    } catch {
      this.update({ failed: true, submitting: false });
    }
  }

  private update(patch: Partial<DesktopCaptureWindowSnapshot>): void {
    this.base = { ...this.base, ...patch };
    this.emit();
  }

  private emit(): void {
    this.snapshot = mergeSnapshot(this.base, this.settingsCore.getSnapshot());
    for (const listener of this.listeners) {
      listener();
    }
  }
}

function mergeSnapshot(
  base: DesktopCaptureWindowSnapshot,
  core: ComposerSettingsCoreSnapshot
): DesktopCaptureWindowSnapshot {
  // The selected agent's options and capabilities both derive from the
  // fenced core options: last good on failure, never a stale interleave.
  const capture = base.capture
    ? {
        ...base.capture,
        agents: base.capture.agents.map((agent) =>
          agent.id === base.agentTargetId && core.options
            ? {
                ...agent,
                capabilities: resolveCaptureAgentCapabilities(core.options),
                composerOptions: core.options
              }
            : agent
        )
      }
    : base.capture;
  return {
    ...base,
    capture,
    composerSettings: core.draft,
    // Only the very first options load blocks composing; background
    // refreshes keep the last good menu interactive.
    refreshingAgentOptions: core.initialLoading,
    failed: base.failed || (core.degraded && core.options === null)
  };
}

function composerDefaultsPatchFromDraft(patch: ComposerSettingsDraft): {
  model?: string | null;
  permissionModeId?: string | null;
  reasoningEffort?: string | null;
  speed?: string | null;
} {
  // browserUse/planMode are session choices, not ledger defaults.
  return {
    ...(patch.model !== undefined ? { model: patch.model } : {}),
    ...(patch.permissionModeId !== undefined
      ? { permissionModeId: patch.permissionModeId }
      : {}),
    ...(patch.reasoningEffort !== undefined
      ? { reasoningEffort: patch.reasoningEffort }
      : {}),
    ...(patch.speed !== undefined ? { speed: patch.speed } : {})
  };
}

function resolveAvailableAgentTargetId(
  agents: DesktopCaptureState["agents"],
  preferredAgentTargetId: string
): string {
  return agents.some((agent) => agent.id === preferredAgentTargetId)
    ? preferredAgentTargetId
    : (agents[0]?.id ?? "");
}

export function prependCapturePromptInstruction(
  content: readonly AgentPromptContentBlock[],
  instruction: string | null | undefined
): AgentPromptContentBlock[] {
  const normalizedInstruction = instruction?.trim() ?? "";
  if (!normalizedInstruction) {
    return [...content];
  }
  const textIndex = content.findIndex((block) => block.type === "text");
  if (textIndex < 0) {
    return [{ text: normalizedInstruction, type: "text" }, ...content];
  }
  return content.map((block, index) => {
    if (index !== textIndex || block.type !== "text") {
      return block;
    }
    const text = block.text ?? "";
    return {
      ...block,
      text: text.trim()
        ? `${normalizedInstruction}\n\n${text}`
        : normalizedInstruction
    };
  });
}

function capturePromptText(
  content: readonly AgentPromptContentBlock[]
): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => block.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}
