import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useCallback, useEffect, useRef } from "react";
import { useServiceSnapshot } from "../bindings/useServiceSnapshot";
import {
  shouldExitConversationRoute,
  type MobileRootStackParamList
} from "../navigation/mobileNavigation";
import type { MobileApplicationService } from "../services/mobileApplicationService";
import { ConversationScreenView } from "./ConversationScreenView";

type Props = NativeStackScreenProps<
  MobileRootStackParamList,
  "Conversation"
> & {
  application: MobileApplicationService;
};

export function ConversationScreen({ application, navigation, route }: Props) {
  const service = application.workspaceActivityService!;
  const model = useServiceSnapshot(service);
  const media = useServiceSnapshot(service.media);
  const quickPrompts = application.quickPromptLibraryService!;
  const quickPromptLibrary = useServiceSnapshot(quickPrompts);
  const snapshot = application.getSnapshot();
  const focused = useIsFocused();
  const creationStarted = useRef(
    route.params.agentSessionId === null && model.creating
  );

  useFocusEffect(
    useCallback(() => {
      if (route.params.agentSessionId) {
        service.selectSession(route.params.agentSessionId);
      } else {
        service.startCreating();
      }
    }, [route.params.agentSessionId, service])
  );

  useEffect(() => {
    if (route.params.agentSessionId !== null) return;
    if (model.creating) {
      creationStarted.current = true;
      return;
    }
    if (creationStarted.current && model.selectedAgentSessionId) {
      navigation.setParams({
        agentSessionId: model.selectedAgentSessionId
      });
    }
  }, [
    model.creating,
    model.selectedAgentSessionId,
    navigation,
    route.params.agentSessionId
  ]);

  const shouldExit = shouldExitConversationRoute({
    focused,
    loading: model.loading,
    routeAgentSessionId: route.params.agentSessionId,
    selectedAgentSessionId: model.selectedAgentSessionId,
    selectedSessionPresent: model.selectedSession !== null
  });
  useEffect(() => {
    if (shouldExit) navigation.goBack();
  }, [navigation, shouldExit]);

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

  return (
    <ConversationScreenView
      deviceName={device.name}
      media={media}
      model={model}
      onBack={() => navigation.goBack()}
      onDraftChange={(value) => service.setDraft(value)}
      onLoadOlder={() => void service.loadOlderMessages()}
      onOpenSession={(agentSessionId) => {
        service.selectSession(agentSessionId);
        navigation.push("Conversation", {
          agentSessionId,
          pairingId: device.pairingId,
          workspaceId: workspace.id
        });
      }}
      onRefreshQuickPrompts={() => quickPrompts.refresh()}
      onRespond={(interaction, input) =>
        service.respondToInteraction(interaction, input)
      }
      onSelectTarget={(id) => service.selectTarget(id)}
      onSend={() => void service.send()}
      onStop={() => service.stop()}
      onUpdateComposerSettings={(settings) =>
        service.updateComposerSettings(settings)
      }
      quickPromptLibrary={quickPromptLibrary}
      workspaceId={workspace.id}
      workspaceName={workspace.name}
    />
  );
}
