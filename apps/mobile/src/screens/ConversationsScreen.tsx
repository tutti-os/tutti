import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect } from "react";
import { useServiceSnapshot } from "../bindings/useServiceSnapshot";
import { MobileActivityView } from "../components/MobileActivityView";
import type { MobileRootStackParamList } from "../navigation/mobileNavigation";
import type { MobileApplicationService } from "../services/mobileApplicationService";

type Props = NativeStackScreenProps<
  MobileRootStackParamList,
  "Conversations"
> & {
  application: MobileApplicationService;
};

export function ConversationsScreen({ application, navigation, route }: Props) {
  const service = application.workspaceActivityService!;
  const model = useServiceSnapshot(service);
  const deviceModel = useServiceSnapshot(application.deviceService!);
  const snapshot = useServiceSnapshot(application);

  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        void application.disconnectDevice();
      }),
    [application, navigation]
  );

  if (
    snapshot.status !== "authenticated" ||
    !snapshot.device ||
    !snapshot.workspace ||
    snapshot.device.pairingId !== route.params.pairingId ||
    snapshot.workspace.id !== route.params.workspaceId
  ) {
    return null;
  }
  const device = snapshot.device;
  const workspace = snapshot.workspace;

  const openConversation = (agentSessionId: string | null): void => {
    if (agentSessionId) {
      service.selectSession(agentSessionId);
    } else {
      service.startCreating();
    }
    navigation.navigate("Conversation", {
      agentSessionId,
      pairingId: device.pairingId,
      workspaceId: workspace.id
    });
  };

  return (
    <MobileActivityView
      connectionPhase={snapshot.connection.phase}
      deviceName={device.name}
      model={model}
      onBack={() => navigation.goBack()}
      onDeleteSession={(id) => service.deleteSession(id)}
      onLoadMoreSearch={() => service.loadMoreSearch()}
      onMeasureLatency={() => application.measureConnectionLatency()}
      onNewSession={() => openConversation(null)}
      onRenameSession={(id, title) => service.renameSession(id, title)}
      onRefreshSessions={() => service.refreshSessions()}
      onRetrySearch={() => service.retrySearch()}
      onSearchQueryChange={(query) => service.setSearchQuery(query)}
      onSelectSession={(id) => openConversation(id)}
      pathScope={deviceModel.pathScope}
      workspaceId={workspace.id}
    />
  );
}
