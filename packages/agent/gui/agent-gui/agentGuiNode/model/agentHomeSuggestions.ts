import type { TranslateFn } from "../../../i18n/index";
import type { AgentMessageMarkdownWorkspaceAppIcon } from "../../../shared/AgentMessageMarkdown";
import type { AgentGUIHomeSuggestionId } from "../../../types";
import type { AgentHomeSuggestionCategory } from "./agentGuiNodeTypes";

export function buildAgentHomeSuggestions(
  t: TranslateFn,
  _workspaceId: string,
  _workspaceAppIcons: readonly AgentMessageMarkdownWorkspaceAppIcon[],
  disabled: readonly AgentGUIHomeSuggestionId[] = []
): AgentHomeSuggestionCategory[] {
  const key = (suffix: string): string =>
    `agentHost.agentGui.homeSuggestions.${suffix}`;
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
