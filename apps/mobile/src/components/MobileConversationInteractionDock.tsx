import {
  canonicalInteractionKey,
  type AgentActivityInteraction
} from "@tutti-os/agent-activity-core";
import { type NativeTheme, useNativeTheme } from "@tutti-os/ui-system/native";
import { ScrollView, StyleSheet, View } from "react-native";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import { mobileKeyboardDismissMode } from "./MobileKeyboardAvoidingView";
import { MobileInteractionCard } from "./MobileConversationRows";

export function MobileConversationInteractionDock({
  interactionStates,
  interactions,
  onRespond
}: {
  interactionStates: WorkspaceActivitySnapshot["interactionStates"];
  interactions: readonly AgentActivityInteraction[];
  onRespond(
    interaction: AgentActivityInteraction,
    input: {
      action?: string;
      optionId?: string;
      payload?: Readonly<Record<string, unknown>>;
    }
  ): void;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  if (interactions.length === 0) return null;

  return (
    <View style={styles.dock} testID="mobile-conversation-interaction-dock">
      <ScrollView
        contentContainerStyle={styles.scrollContent}
        keyboardDismissMode={mobileKeyboardDismissMode}
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
      >
        <View style={styles.content}>
          {interactions.map((interaction) => {
            const interactionKey = canonicalInteractionKey(
              interaction.agentSessionId,
              interaction.turnId,
              interaction.requestId
            );
            const state = interactionStates[interactionKey] ?? {
              failed: false,
              runtimeAvailable: false,
              submitting: false
            };
            return (
              <MobileInteractionCard
                failed={state.failed}
                interaction={interaction}
                key={interactionKey}
                onSubmit={(input) => onRespond(interaction, input)}
                runtimeAvailable={state.runtimeAvailable}
                submitting={state.submitting}
              />
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    content: {
      alignSelf: "center",
      gap: theme.space.small,
      maxWidth: 760,
      width: "100%"
    },
    dock: {
      backgroundColor: theme.color.background,
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      maxHeight: "40%"
    },
    scrollContent: {
      paddingBottom: theme.space.small,
      paddingHorizontal: theme.space.medium,
      paddingTop: theme.space.small
    }
  });
}
