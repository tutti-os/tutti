import type { MobileApplicationSnapshot } from "../services/mobileApplicationService";

export type MobileRootStackParamList = {
  Login: undefined;
  Devices: undefined;
  Conversations: {
    pairingId: string;
    workspaceId: string;
  };
  Conversation: {
    agentSessionId: string | null;
    pairingId: string;
    workspaceId: string;
  };
};

export type MobileRouteName = keyof MobileRootStackParamList;

export function availableMobileRoutes(
  snapshot: Exclude<MobileApplicationSnapshot, { status: "bootstrapping" }>
): readonly MobileRouteName[] {
  if (snapshot.status === "unauthenticated") return ["Login"];
  return snapshot.device && snapshot.workspace
    ? ["Devices", "Conversations", "Conversation"]
    : ["Devices"];
}

export function shouldExitConversationRoute({
  focused,
  loading,
  routeAgentSessionId,
  selectedAgentSessionId,
  selectedSessionPresent
}: {
  focused: boolean;
  loading: boolean;
  routeAgentSessionId: string | null;
  selectedAgentSessionId: string | null;
  selectedSessionPresent: boolean;
}): boolean {
  return (
    focused &&
    !loading &&
    routeAgentSessionId !== null &&
    selectedAgentSessionId === routeAgentSessionId &&
    !selectedSessionPresent
  );
}
