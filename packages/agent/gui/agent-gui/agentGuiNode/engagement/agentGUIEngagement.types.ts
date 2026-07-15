export type AgentGUIComposerFocusMethod =
  | "keyboard"
  | "pointer"
  | "programmatic";

export type AgentGUIComposerContentType = "image" | "large_text" | "text";

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
    });

export interface AgentGUIComposerEngagement {
  contentEntered(input: {
    contentType: AgentGUIComposerContentType;
    hadPrefill: boolean;
  }): void;
  focused(focusMethod: AgentGUIComposerFocusMethod): void;
}

export type AgentGUIEngagementEventSink = (
  event: AgentGUIEngagementEvent
) => Promise<void> | void;
