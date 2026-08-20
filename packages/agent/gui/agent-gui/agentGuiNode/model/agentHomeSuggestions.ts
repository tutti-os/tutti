import { createRichTextMentionHref } from "@tutti-os/ui-rich-text/core";
import type { TranslateFn } from "../../../i18n/index";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentGUIHomeSuggestionId } from "../../../types";
import type { AgentHomeSuggestionCategory } from "./agentGuiNodeTypes";

const TASK_CENTER_WORKSPACE_APP_ID = "issue-manager";

export function buildAgentHomeSuggestions(
  t: TranslateFn,
  workspaceId: string,
  workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[],
  disabled: readonly AgentGUIHomeSuggestionId[] = []
): AgentHomeSuggestionCategory[] {
  const key = (suffix: string): string =>
    `agentHost.agentGui.homeSuggestions.${suffix}`;
  const taskCenterLabel = t(key("breakdown.taskCenterLabel"));
  // Resolve the Task Center app icon so the seeded mention renders as a proper
  // workspace-app chip (same as a picker-inserted one), not a bare fallback.
  const taskCenterIconUrl =
    workspaceAppIcons
      .find((entry) => entry.appId === TASK_CENTER_WORKSPACE_APP_ID)
      ?.iconUrl?.trim() || undefined;
  // A workspace-app mention only rehydrates into a chip when it carries a
  // workspaceId; without one (e.g. preview), fall back to plain "@label" text.
  const taskCenterMention = workspaceId
    ? `[@${taskCenterLabel}](${createRichTextMentionHref({
        providerId: "workspace-app",
        entityId: TASK_CENTER_WORKSPACE_APP_ID,
        label: taskCenterLabel,
        scope: {
          workspaceId,
          ...(taskCenterIconUrl ? { icon: taskCenterIconUrl } : {})
        }
      })})`
    : `@${taskCenterLabel}`;
  const categories: AgentHomeSuggestionCategory[] = [
    {
      id: "meet-tutti",
      icon: "about",
      label: t(key("about.title")),
      prompt: t(key("about.prompt"))
    },
    {
      id: "clone-github-repository",
      icon: "github",
      label: t(key("cloneGithubRepository.title")),
      prompt: t(key("cloneGithubRepository.prompt"))
    },
    {
      id: "task-breakdown",
      icon: "breakdown",
      label: t(key("breakdown.title")),
      prompt: t(key("breakdown.prompt"), { taskCenterMention })
    },
    {
      id: "quality-review",
      icon: "review",
      // Fills the composer with the review prompt; the user types "@" where they
      // want to pick the session whose output to review.
      label: t(key("review.title")),
      prompt: t(key("review.prompt"))
    },
    {
      id: "agent-interaction",
      icon: "interaction",
      // Fills the composer with the interaction prompt; the user types "@" where
      // they want to pick the agents to have interact.
      label: t(key("interaction.title")),
      prompt: t(key("interaction.prompt"))
    },
    {
      id: "import-session",
      icon: "import",
      label: t(key("import.title")),
      action: "import-session"
    }
  ];
  const disabledIds = new Set<string>(disabled);
  return categories.filter((category) => !disabledIds.has(category.id));
}
