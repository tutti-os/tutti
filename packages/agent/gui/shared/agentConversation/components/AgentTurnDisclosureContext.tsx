import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type JSX,
  type ReactNode
} from "react";

export interface AgentTurnDisclosureStore {
  expandedOverrides: Readonly<Record<string, boolean>>;
  setExpandedOverride: (key: string, expanded: boolean) => void;
}

const AgentTurnDisclosureContext =
  createContext<AgentTurnDisclosureStore | null>(null);

export function AgentTurnDisclosureProvider({
  children
}: {
  children: ReactNode;
}): JSX.Element {
  const store = useAgentTurnDisclosureStoreState();
  return (
    <AgentTurnDisclosureContext.Provider value={store}>
      {children}
    </AgentTurnDisclosureContext.Provider>
  );
}

export function useAgentTurnDisclosureStore(): AgentTurnDisclosureStore {
  const contextStore = useContext(AgentTurnDisclosureContext);
  const localStore = useAgentTurnDisclosureStoreState();
  return contextStore ?? localStore;
}

function useAgentTurnDisclosureStoreState(): AgentTurnDisclosureStore {
  const [expandedOverrides, setExpandedOverrides] = useState<
    Record<string, boolean>
  >({});
  const setExpandedOverride = useCallback((key: string, expanded: boolean) => {
    setExpandedOverrides((previous) =>
      previous[key] === expanded ? previous : { ...previous, [key]: expanded }
    );
  }, []);
  return useMemo(
    () => ({ expandedOverrides, setExpandedOverride }),
    [expandedOverrides, setExpandedOverride]
  );
}
