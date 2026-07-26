import type { AgentActivitySessionSettings } from "@tutti-os/agent-activity-core";
import {
  NativeButton,
  NativeListRow,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";

type ComposerSettingMenu =
  | "model"
  | "reasoning"
  | "speed"
  | "permission"
  | null;

export function MobileComposerSettingsSheet({
  model,
  onUpdate
}: {
  model: WorkspaceActivitySnapshot;
  onUpdate(settings: AgentActivitySessionSettings): void;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [menu, setMenu] = useState<ComposerSettingMenu>(null);
  const options = model.composerOptions;
  const selectedModel = model.composerSettings.model ?? null;
  const reasoningOptions = selectedModel
    ? (options?.reasoningOptionsByModel?.[selectedModel]?.options ??
      options?.reasoningEfforts ??
      [])
    : (options?.reasoningEfforts ?? []);
  const showsModelChip = Boolean(
    model.composerSettingsSupport.model && options?.models.length
  );

  const closeWith = (settings: AgentActivitySessionSettings): void => {
    onUpdate(settings);
    setMenu(null);
  };

  return (
    <>
      <View style={styles.chips}>
        {showsModelChip ? (
          <ComposerChip
            label={[
              selectedOptionLabel(options?.models ?? [], selectedModel) ??
                t("model"),
              model.composerSettingsSupport.reasoning
                ? selectedOptionLabel(
                    reasoningOptions,
                    model.composerSettings.reasoningEffort ?? null
                  )
                : null
            ]
              .filter(Boolean)
              .join(" ")}
            onPress={() => setMenu("model")}
          />
        ) : null}
        {!showsModelChip &&
        model.composerSettingsSupport.reasoning &&
        reasoningOptions.length ? (
          <ComposerChip
            label={
              selectedOptionLabel(
                reasoningOptions,
                model.composerSettings.reasoningEffort ?? null
              ) ?? t("reasoning")
            }
            onPress={() => setMenu("reasoning")}
          />
        ) : null}
        {model.composerSettingsSupport.speed && options?.speeds.length ? (
          <ComposerChip
            label={
              selectedOptionLabel(
                options?.speeds ?? [],
                model.composerSettings.speed ?? null
              ) ?? t("speed")
            }
            onPress={() => setMenu("speed")}
          />
        ) : null}
        {model.composerSettingsSupport.permission &&
        options?.permissionConfig?.modes.length ? (
          <ComposerChip
            label={
              selectedOptionLabel(
                options?.permissionConfig?.modes ?? [],
                model.composerSettings.permissionModeId ?? null
              ) ?? t("defaultPermissions")
            }
            onPress={() => setMenu("permission")}
          />
        ) : null}
      </View>

      <NativeSheet
        closeAccessibilityLabel={t("closeSheet")}
        onOpenChange={(open) => !open && setMenu(null)}
        open={menu !== null}
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{titleForMenu(menu)}</Text>
          <ScrollView contentContainerStyle={styles.options}>
            {menu === "model"
              ? [
                  ...(options?.models.map((option) => (
                    <NativeListRow
                      key={`model:${option.value}`}
                      onPress={() => closeWith({ model: option.value })}
                      selected={option.value === selectedModel}
                      title={option.label}
                    />
                  )) ?? []),
                  ...(model.composerSettingsSupport.reasoning &&
                  reasoningOptions.length
                    ? [
                        <Text key="reasoning-title" style={styles.sectionTitle}>
                          {t("reasoning")}
                        </Text>,
                        ...reasoningOptions.map((option) => (
                          <NativeListRow
                            key={`reasoning:${option.value}`}
                            onPress={() =>
                              closeWith({ reasoningEffort: option.value })
                            }
                            selected={
                              option.value ===
                              model.composerSettings.reasoningEffort
                            }
                            title={option.label}
                          />
                        ))
                      ]
                    : [])
                ]
              : null}
            {menu === "reasoning"
              ? reasoningOptions.map((option) => (
                  <NativeListRow
                    key={option.value}
                    onPress={() => closeWith({ reasoningEffort: option.value })}
                    selected={
                      option.value === model.composerSettings.reasoningEffort
                    }
                    title={option.label}
                  />
                ))
              : null}
            {menu === "speed"
              ? options?.speeds.map((option) => (
                  <NativeListRow
                    key={option.value}
                    onPress={() => closeWith({ speed: option.value })}
                    selected={option.value === model.composerSettings.speed}
                    title={option.label}
                  />
                ))
              : null}
            {menu === "permission"
              ? options?.permissionConfig?.modes.map((option) => (
                  <NativeListRow
                    description={option.description}
                    key={option.id}
                    onPress={() => closeWith({ permissionModeId: option.id })}
                    selected={
                      option.id === model.composerSettings.permissionModeId
                    }
                    title={option.label ?? option.id}
                  />
                ))
              : null}
            {model.composerOptionsLoadStatus === "loading" ? (
              <Text style={styles.loading}>{t("loading")}</Text>
            ) : null}
          </ScrollView>
        </View>
      </NativeSheet>
    </>
  );
}

function ComposerChip({ label, onPress }: { label: string; onPress(): void }) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <NativeButton
      label={label}
      onPress={onPress}
      size="compact"
      style={styles.chip}
      variant="secondary"
    />
  );
}

function selectedOptionLabel(
  options: readonly { label?: string; value?: string; id?: string }[],
  value: string | null
): string | null {
  if (!value) return null;
  const option = options.find(
    (candidate) => candidate.value === value || candidate.id === value
  );
  return option?.label ?? value;
}

function titleForMenu(menu: ComposerSettingMenu): string {
  switch (menu) {
    case "model":
      return t("model");
    case "reasoning":
      return t("reasoning");
    case "speed":
      return t("speed");
    case "permission":
      return t("permissions");
    default:
      return "";
  }
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    chip: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.panel,
      borderRadius: 20,
      minHeight: theme.control.compact,
      paddingHorizontal: theme.space.medium
    },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.small },
    loading: { color: theme.color.muted, padding: theme.space.medium },
    options: { padding: theme.space.small },
    sectionTitle: {
      color: theme.color.muted,
      fontSize: 13,
      fontWeight: "600",
      paddingHorizontal: theme.space.small,
      paddingTop: theme.space.medium
    },
    sheet: { minHeight: 180, padding: theme.space.medium },
    sheetTitle: {
      color: theme.color.text,
      fontSize: 17,
      fontWeight: "700",
      marginBottom: theme.space.small
    }
  });
}
