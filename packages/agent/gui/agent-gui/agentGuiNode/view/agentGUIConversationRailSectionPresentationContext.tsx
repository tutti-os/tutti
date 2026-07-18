import { createContext, useContext } from "react";

const AgentGUIConversationRailSectionBatchDeletionDisabledContext =
  createContext<boolean | null>(null);
const AgentGUIConversationRailSectionProjectActionLockedContext = createContext<
  boolean | null
>(null);
const AgentGUIConversationRailSectionProjectDragDisabledContext = createContext<
  boolean | null
>(null);

interface AgentGUIConversationRailSectionPresentationProviderProps {
  batchDeletionDisabled: boolean;
  children: React.ReactNode;
  projectActionLocked: boolean;
  projectDragDisabled: boolean;
}

export function AgentGUIConversationRailSectionPresentationProvider({
  batchDeletionDisabled,
  children,
  projectActionLocked,
  projectDragDisabled
}: AgentGUIConversationRailSectionPresentationProviderProps): React.JSX.Element {
  return (
    <AgentGUIConversationRailSectionBatchDeletionDisabledContext.Provider
      value={batchDeletionDisabled}
    >
      <AgentGUIConversationRailSectionProjectActionLockedContext.Provider
        value={projectActionLocked}
      >
        <AgentGUIConversationRailSectionProjectDragDisabledContext.Provider
          value={projectDragDisabled}
        >
          {children}
        </AgentGUIConversationRailSectionProjectDragDisabledContext.Provider>
      </AgentGUIConversationRailSectionProjectActionLockedContext.Provider>
    </AgentGUIConversationRailSectionBatchDeletionDisabledContext.Provider>
  );
}

export function useAgentGUIConversationRailSectionBatchDeletionDisabled(): boolean {
  return readSectionPresentationValue(
    useContext(AgentGUIConversationRailSectionBatchDeletionDisabledContext),
    "batch deletion disabled"
  );
}

export function useAgentGUIConversationRailSectionProjectActionLocked(): boolean {
  return readSectionPresentationValue(
    useContext(AgentGUIConversationRailSectionProjectActionLockedContext),
    "project action locked"
  );
}

export function useAgentGUIConversationRailSectionProjectDragDisabled(): boolean {
  return readSectionPresentationValue(
    useContext(AgentGUIConversationRailSectionProjectDragDisabledContext),
    "project drag disabled"
  );
}

function readSectionPresentationValue(
  value: boolean | null,
  name: string
): boolean {
  if (value === null) {
    throw new Error(`Missing AgentGUI Rail Section ${name} provider`);
  }
  return value;
}
