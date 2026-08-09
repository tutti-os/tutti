import type { AgentActivitySessionSettings } from "@tutti-os/agent-activity-core";
import {
  NativeButton,
  NativeControlGlyph,
  NativeListRow,
  NativeSheet,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useRef, useState } from "react";
import { ScrollView, StyleSheet, Text, View } from "react-native";
import { t } from "../i18n";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";

export type ComposerSettingMenu =
  | "model"
  | "reasoning"
  | "speed"
  | "permission";

export function MobileComposerSettingsSheet({
  activationId,
  disabled,
  menu,
  model,
  onMenuChange,
  onUpdate
}: {
  activationId: number | null;
  disabled: boolean;
  menu: ComposerSettingMenu | null;
  model: WorkspaceActivitySnapshot;
  onMenuChange(menu: ComposerSettingMenu | null): void;
  onUpdate(settings: AgentActivitySessionSettings): void;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const activeActivationIdRef = useRef(activationId);
  const disabledRef = useRef(disabled);
  const chipRailMetricsRef = useRef({
    contentWidth: 0,
    offset: 0,
    viewportWidth: 0
  });
  const [chipRailHints, setChipRailHints] = useState({
    leading: false,
    trailing: false
  });
  activeActivationIdRef.current = activationId;
  disabledRef.current = disabled;
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
  const updateChipRailMetrics = (
    metrics: Partial<(typeof chipRailMetricsRef)["current"]>
  ): void => {
    Object.assign(chipRailMetricsRef.current, metrics);
    const { contentWidth, offset, viewportWidth } = chipRailMetricsRef.current;
    const maxOffset = Math.max(0, contentWidth - viewportWidth);
    const visibleOffset = Math.min(maxOffset, Math.max(0, offset));
    const leading = visibleOffset > 4;
    const trailing = maxOffset - visibleOffset > 4;
    setChipRailHints((current) =>
      current.leading === leading && current.trailing === trailing
        ? current
        : { leading, trailing }
    );
  };

  const closeWith = (settings: AgentActivitySessionSettings): void => {
    if (
      activationId === null ||
      activeActivationIdRef.current !== activationId ||
      disabledRef.current
    ) {
      return;
    }
    onUpdate(settings);
    onMenuChange(null);
  };

  return (
    <>
      <View style={styles.chipRail}>
        <ScrollView
          contentContainerStyle={styles.chips}
          fadingEdgeLength={theme.space.large}
          horizontal
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(width) =>
            updateChipRailMetrics({ contentWidth: width })
          }
          onLayout={({ nativeEvent }) =>
            updateChipRailMetrics({ viewportWidth: nativeEvent.layout.width })
          }
          onScroll={({ nativeEvent }) =>
            updateChipRailMetrics({ offset: nativeEvent.contentOffset.x })
          }
          scrollEventThrottle={16}
          showsHorizontalScrollIndicator={false}
          testID="mobile-composer-settings-rail"
        >
          {showsModelChip ? (
            <ComposerChip
              disabled={disabled}
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
              onPress={() => onMenuChange("model")}
              testID="mobile-composer-model-settings"
            />
          ) : null}
          {!showsModelChip &&
          model.composerSettingsSupport.reasoning &&
          reasoningOptions.length ? (
            <ComposerChip
              disabled={disabled}
              label={
                selectedOptionLabel(
                  reasoningOptions,
                  model.composerSettings.reasoningEffort ?? null
                ) ?? t("reasoning")
              }
              onPress={() => onMenuChange("reasoning")}
              testID="mobile-composer-reasoning-settings"
            />
          ) : null}
          {model.composerSettingsSupport.speed && options?.speeds.length ? (
            <ComposerChip
              disabled={disabled}
              label={
                selectedOptionLabel(
                  options?.speeds ?? [],
                  model.composerSettings.speed ?? null
                ) ?? t("speed")
              }
              onPress={() => onMenuChange("speed")}
              testID="mobile-composer-speed-settings"
            />
          ) : null}
          {model.composerSettingsSupport.permission &&
          options?.permissionConfig?.modes.length ? (
            <ComposerChip
              disabled={disabled}
              label={
                selectedOptionLabel(
                  options?.permissionConfig?.modes ?? [],
                  model.composerSettings.permissionModeId ?? null
                ) ?? t("defaultPermissions")
              }
              onPress={() => onMenuChange("permission")}
              testID="mobile-composer-permission-settings"
            />
          ) : null}
        </ScrollView>
        {chipRailHints.leading ? (
          <View
            pointerEvents="none"
            style={[styles.chipRailHint, styles.chipRailHintLeading]}
            testID="mobile-composer-settings-leading-hint"
          >
            <NativeControlGlyph
              color={theme.color.textSecondary}
              direction="left"
              size={14}
              variant="chevron"
            />
          </View>
        ) : null}
        {chipRailHints.trailing ? (
          <View
            pointerEvents="none"
            style={[styles.chipRailHint, styles.chipRailHintTrailing]}
            testID="mobile-composer-settings-trailing-hint"
          >
            <NativeControlGlyph
              color={theme.color.textSecondary}
              direction="right"
              size={14}
              variant="chevron"
            />
          </View>
        ) : null}
      </View>

      <NativeSheet
        closeAccessibilityLabel={t("closeSheet")}
        onOpenChange={(open) => !open && onMenuChange(null)}
        open={!disabled && menu !== null}
      >
        <View style={styles.sheet}>
          <Text style={styles.sheetTitle}>{titleForMenu(menu)}</Text>
          <ScrollView contentContainerStyle={styles.options}>
            {menu === "model"
              ? [
                  ...(options?.models.map((option) => (
                    <NativeListRow
                      disabled={disabled}
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
                            disabled={disabled}
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
                    disabled={disabled}
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
                    disabled={disabled}
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
                    disabled={disabled}
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

function ComposerChip({
  disabled,
  label,
  onPress,
  testID
}: {
  disabled: boolean;
  label: string;
  onPress(): void;
  testID: string;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  return (
    <NativeButton
      disabled={disabled}
      label={label}
      onPress={onPress}
      size="regular"
      style={styles.chip}
      testID={testID}
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

function titleForMenu(menu: ComposerSettingMenu | null): string {
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
      borderColor: theme.color.border,
      borderRadius: theme.control.regular / 2,
      minHeight: theme.control.regular,
      paddingHorizontal: theme.space.small
    },
    chipRail: { flex: 1, minWidth: 0, position: "relative" },
    chipRailHint: {
      alignItems: "center",
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.control.regular / 2,
      borderWidth: StyleSheet.hairlineWidth,
      height: theme.control.regular,
      justifyContent: "center",
      opacity: 0.96,
      position: "absolute",
      top: 0,
      width: 24
    },
    chipRailHintLeading: { left: 0 },
    chipRailHintTrailing: { right: 0 },
    chips: {
      alignItems: "center",
      flexDirection: "row",
      gap: 6,
      paddingRight: theme.space.small
    },
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
