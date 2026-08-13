export type AgentGUIComposerFocusMethod =
  | "keyboard"
  | "pointer"
  | "programmatic";

export type AgentGUIComposerContentType = "image" | "large_text" | "text";

export type AgentGUIQuickPromptType = "saved" | "recommended_template";

export interface AgentGUIEngagementContext {
  agentSessionId: string | null;
  agentTargetId: string | null;
  composerReady: boolean;
  conversationState: "existing" | "new";
  provider: string;
}

interface AgentGUIEngagementEventBase extends AgentGUIEngagementContext {
  panelVisitId: string;
}

export type AgentGUIEngagementEvent =
  | (AgentGUIEngagementEventBase & {
      type: "panel_exposed";
    })
  | (AgentGUIEngagementEventBase & {
      type: "composer_focused";
      focusMethod: AgentGUIComposerFocusMethod;
    })
  | (AgentGUIEngagementEventBase & {
      type: "composer_content_entered";
      contentType: AgentGUIComposerContentType;
      hadPrefill: boolean;
    })
  | (AgentGUIEngagementEventBase & {
      source: "composer_input";
      type: "quick_prompt_panel_opened";
    })
  | (AgentGUIEngagementEventBase & {
      promptType: AgentGUIQuickPromptType;
      source: "composer_input";
      type: "quick_prompt_used";
    });

export interface AgentGUIComposerEngagement {
  contentEntered(input: {
    contentType: AgentGUIComposerContentType;
    hadPrefill: boolean;
  }): void;
  focused(focusMethod: AgentGUIComposerFocusMethod): void;
  quickPromptPanelOpened?(): void;
  quickPromptUsed?(promptType: AgentGUIQuickPromptType): void;
}

export type AgentGUIEngagementEventSink = (
  event: AgentGUIEngagementEvent
) => Promise<void> | void;
