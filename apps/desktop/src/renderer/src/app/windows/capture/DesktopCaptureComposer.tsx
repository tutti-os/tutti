import { useEffect, useMemo } from "react";
import type {
  AgentActivityComposerOptions,
  AgentPromptContentBlock
} from "@tutti-os/agent-activity-core";
import {
  AgentGUIQuickComposer,
  type AgentGUIQuickComposerAgentTarget,
  type AgentGUIQuickComposerTargetCapabilities
} from "@tutti-os/agent-gui/quick-composer";
import { Switch } from "@tutti-os/ui-system";
import { createTuttiExternalRichTextMentionService } from "@tutti-os/workspace-external-core/rich-text";
import type { DesktopCaptureComposerSettings } from "../../../../../shared/contracts/capture.ts";
import type { DesktopLocale } from "../../../../../shared/i18n/core/locale.ts";
import type { DesktopCaptureWindowController } from "./desktopCaptureWindowController.ts";

export function DesktopCaptureComposer({
  agentTargets,
  capabilitiesByAgentTargetId,
  composerOptions,
  composerOptionsLoading,
  composerSettings,
  content,
  controller,
  disabled,
  locale,
  projectPath,
  selectedAgentTargetId,
  taskActionLabel,
  taskActionHint,
  taskInstruction,
  trackWithTask,
  workspaceId
}: {
  agentTargets: readonly AgentGUIQuickComposerAgentTarget[];
  capabilitiesByAgentTargetId: Readonly<
    Record<string, AgentGUIQuickComposerTargetCapabilities | undefined>
  >;
  composerOptions: AgentActivityComposerOptions | null;
  composerOptionsLoading: boolean;
  composerSettings: DesktopCaptureComposerSettings;
  content: readonly AgentPromptContentBlock[];
  controller: DesktopCaptureWindowController;
  disabled: boolean;
  locale: DesktopLocale;
  projectPath: string | null;
  selectedAgentTargetId: string;
  taskActionHint: string;
  taskActionLabel: string;
  taskInstruction: string;
  trackWithTask: boolean;
  workspaceId: string;
}) {
  const mentionService = useMemo(
    () =>
      createTuttiExternalRichTextMentionService({
        getBridge: () => controller.mentionBridge
      }),
    [controller]
  );

  useEffect(() => () => mentionService.dispose(), [mentionService]);

  return (
    <AgentGUIQuickComposer
      agentTargets={agentTargets}
      capabilitiesByAgentTargetId={capabilitiesByAgentTargetId}
      composerActionAccessory={
        <div
          className="inline-flex shrink-0 items-center gap-2"
          title={taskActionHint}
        >
          <span
            className="text-[12px] leading-4 text-[var(--text-secondary)]"
            id="capture-track-with-task-label"
          >
            {taskActionLabel}
          </span>
          <Switch
            aria-labelledby="capture-track-with-task-label"
            checked={trackWithTask}
            disabled={disabled}
            size="sm"
            onCheckedChange={(checked) => controller.setTrackWithTask(checked)}
          />
        </div>
      }
      composerActionPlacement="footer"
      composerSettings={{
        loading: composerOptionsLoading,
        onChange: (patch) => controller.setComposerSettings(patch),
        options: composerOptions,
        value: composerSettings
      }}
      content={content}
      disabled={disabled}
      fillAvailableHeight={true}
      inputSurfaceVariant="borderless"
      locale={locale}
      mentionService={mentionService}
      menuViewportTopInset={48}
      selectedAgentTargetId={selectedAgentTargetId}
      selectedProjectPath={projectPath}
      userProjectApi={controller.userProjectApi}
      workspaceId={workspaceId}
      onAgentTargetChange={(agentTargetId) =>
        controller.setAgentTargetId(agentTargetId)
      }
      onContentChange={(nextContent) => controller.setContent(nextContent)}
      onProjectPathChange={controller.setProjectPath}
      onRequestWorkspaceReferences={async () => ({
        files: await controller.selectFiles(),
        mentionItems: []
      })}
      onSubmit={({ agentTargetId, content: nextContent, displayPrompt }) =>
        void controller.submit(
          agentTargetId,
          nextContent,
          displayPrompt,
          taskInstruction
        )
      }
    />
  );
}
