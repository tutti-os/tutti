import type { AgentActivitySessionSettings } from "@tutti-os/agent-activity-core";
import {
  NativeControlGlyph,
  NativeIconButton,
  NativeListRow,
  type NativeTheme,
  useNativeTheme
} from "@tutti-os/ui-system/native";
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  type NativeSyntheticEvent,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  type TextInputSelectionChangeEventData,
  View
} from "react-native";
import { t } from "../i18n";
import type { MobileQuickPromptLibrarySnapshot } from "../services/mobileQuickPromptLibraryService";
import type { WorkspaceActivitySnapshot } from "../services/workspaceActivityService";
import {
  MobileComposerSettingsSheet,
  type ComposerSettingMenu
} from "./MobileComposerSettingsSheet";
import {
  MobileKeyboardAvoidingView,
  mobileKeyboardDismissMode
} from "./MobileKeyboardAvoidingView";
import {
  addMobileQuickPrompt,
  filterMobileQuickPrompts,
  previewMobileQuickPromptContent,
  type MobileTextSelection
} from "./mobileQuickPromptPresentation";
import { MobileComposerContextSelectors } from "./MobileComposerContextSelectors";

type ComposerToolsMenu = "tools" | "model" | "permission" | "quickPrompts";

type ComposerOverlay =
  | {
      activationId: number;
      kind: "settings";
      menu: ComposerSettingMenu;
    }
  | { activationId: number; kind: "tools"; menu: ComposerToolsMenu }
  | null;

export function MobileComposerDock({
  model,
  quickPromptLibrary,
  onDraftChange,
  onRefreshQuickPrompts,
  onSelectProject,
  onSelectTarget,
  onSend,
  onStop,
  onUpdate
}: {
  model: WorkspaceActivitySnapshot;
  quickPromptLibrary: MobileQuickPromptLibrarySnapshot;
  onDraftChange(value: string): void;
  onRefreshQuickPrompts(): Promise<void>;
  onSelectProject(path: string | null): void;
  onSelectTarget(agentTargetId: string): void;
  onSend(): void;
  onStop(): void;
  onUpdate(settings: AgentActivitySessionSettings): void;
}) {
  const theme = useNativeTheme();
  const styles = createStyles(theme);
  const [overlay, setOverlay] = useState<ComposerOverlay>(null);
  const [quickPromptQuery, setQuickPromptQuery] = useState("");
  const inputRef = useRef<TextInput>(null);
  const nextOverlayActivationIdRef = useRef(1);
  const selectionRef = useRef<MobileTextSelection | null>(null);
  const hasActiveTurn = Boolean(
    model.selectedSession?.activeTurnId && !model.creating
  );
  const canSend = Boolean(
    model.draft.trim() &&
    (!model.creating || model.selectedAgentTargetId) &&
    model.commandsAvailable &&
    (!model.creating || model.composerOptionsLoadStatus !== "loading") &&
    !model.sending
  );
  const modelOptions = model.composerOptions?.models ?? [];
  const permissionOptions =
    model.composerOptions?.permissionConfig?.modes ?? [];
  const hasComposerTools =
    (model.composerSettingsSupport.model && modelOptions.length > 0) ||
    (model.composerSettingsSupport.permission &&
      permissionOptions.length > 0) ||
    model.composerSettingsSupport.plan ||
    quickPromptLibrary.enabled ||
    model.composerOptionsLoadStatus === "loading";
  const filteredQuickPrompts = filterMobileQuickPrompts(
    quickPromptLibrary.prompts,
    quickPromptQuery
  );
  const selectedModelLabel =
    modelOptions.find((option) => option.value === model.composerSettings.model)
      ?.label ?? t("model");
  const selectedPermissionLabel =
    permissionOptions.find(
      (option) => option.id === model.composerSettings.permissionModeId
    )?.label ?? t("defaultPermissions");
  const settingsMenu = overlay?.kind === "settings" ? overlay.menu : null;
  const toolsMenu = overlay?.kind === "tools" ? overlay.menu : null;
  const settingsActivationId =
    overlay?.kind === "settings" ? overlay.activationId : null;
  const toolsActivationId =
    overlay?.kind === "tools" ? overlay.activationId : null;
  const setSettingsMenu = (menu: ComposerSettingMenu | null): void => {
    if (menu !== null) {
      const activationId = nextOverlayActivationIdRef.current++;
      setOverlay((current) =>
        current?.kind === "settings"
          ? { ...current, menu }
          : { activationId, kind: "settings", menu }
      );
      return;
    }
    setOverlay((current) =>
      current?.kind === "settings" &&
      current.activationId === settingsActivationId
        ? null
        : current
    );
  };
  const setToolsMenu = (menu: ComposerToolsMenu | null): void => {
    if (menu !== null) {
      const activationId = nextOverlayActivationIdRef.current++;
      setOverlay((current) =>
        current?.kind === "tools"
          ? { ...current, menu }
          : { activationId, kind: "tools", menu }
      );
      return;
    }
    setOverlay((current) =>
      current?.kind === "tools" && current.activationId === toolsActivationId
        ? null
        : current
    );
  };
  useEffect(() => {
    if (!model.commandsAvailable) setOverlay(null);
  }, [model.commandsAvailable]);
  useEffect(() => {
    if (
      toolsMenu === "quickPrompts" &&
      quickPromptLibrary.status !== "loading" &&
      !quickPromptLibrary.enabled
    ) {
      setQuickPromptQuery("");
      setToolsMenu("tools");
    }
  }, [toolsMenu, quickPromptLibrary.enabled, quickPromptLibrary.status]);
  const openToolsMenu = (): void => {
    setToolsMenu("tools");
    void onRefreshQuickPrompts();
  };
  const selectQuickPrompt = (content: string): void => {
    const added = addMobileQuickPrompt(
      model.draft,
      content,
      selectionRef.current
    );
    onDraftChange(added.value);
    selectionRef.current = {
      end: added.caret,
      start: added.caret
    };
    setQuickPromptQuery("");
    setToolsMenu(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.setNativeProps({
        selection: selectionRef.current
      });
    });
  };

  return (
    <View style={styles.dock}>
      {model.creating ? (
        <MobileComposerContextSelectors
          model={model}
          onSelectProject={onSelectProject}
          onSelectTarget={onSelectTarget}
        />
      ) : null}
      <View style={styles.composerShell}>
        <View style={styles.inputRow}>
          <TextInput
            ref={inputRef}
            editable={!model.sending && model.commandsAvailable}
            multiline
            onChangeText={onDraftChange}
            onSelectionChange={(
              event: NativeSyntheticEvent<TextInputSelectionChangeEventData>
            ) => {
              selectionRef.current = event.nativeEvent.selection;
            }}
            placeholder={t("messageHint")}
            placeholderTextColor={theme.color.muted}
            style={styles.input}
            value={model.draft}
          />
        </View>
        <View style={styles.actionRow}>
          <NativeIconButton
            accessibilityLabel={t("moreActions")}
            disabled={!model.commandsAvailable}
            icon={
              <NativeControlGlyph
                color={theme.color.textSecondary}
                size={20}
                variant="add"
              />
            }
            onPress={openToolsMenu}
            style={styles.addButton}
            testID="mobile-composer-tools"
            variant="ghost"
          />
          <View style={styles.settingsRail}>
            <MobileComposerSettingsSheet
              activationId={settingsActivationId}
              disabled={!model.commandsAvailable}
              menu={settingsMenu}
              model={model}
              onMenuChange={setSettingsMenu}
              onUpdate={onUpdate}
            />
          </View>
          {hasActiveTurn ? (
            <NativeIconButton
              accessibilityLabel={t("stop")}
              disabled={!model.commandsAvailable}
              icon={
                <NativeControlGlyph
                  color={theme.color.background}
                  size={20}
                  variant="stop"
                />
              }
              onPress={onStop}
              style={styles.actionButton}
            />
          ) : canSend ? (
            <NativeIconButton
              accessibilityLabel={
                model.ambiguousSubmission ? t("retry") : t("send")
              }
              icon={
                <NativeControlGlyph
                  color={theme.color.background}
                  size={20}
                  variant="send"
                />
              }
              onPress={onSend}
              style={styles.actionButton}
            />
          ) : model.sending ? (
            <View style={styles.actionSlot}>
              <ActivityIndicator color={theme.color.text} size="small" />
            </View>
          ) : (
            <View style={styles.actionSlot} />
          )}
        </View>
      </View>

      <Modal
        animationType="fade"
        onRequestClose={() => setToolsMenu(null)}
        presentationStyle="overFullScreen"
        statusBarTranslucent
        transparent
        visible={model.commandsAvailable && toolsMenu !== null}
      >
        <MobileKeyboardAvoidingView
          keyboardVerticalOffset={0}
          style={styles.modalRoot}
        >
          <Pressable onPress={() => setToolsMenu(null)} style={styles.backdrop}>
            <Pressable
              onPress={(event) => event.stopPropagation()}
              style={styles.menu}
            >
              {toolsMenu === "tools" ? (
                <>
                  {model.composerSettingsSupport.model &&
                  modelOptions.length > 0 ? (
                    <NativeListRow
                      description={selectedModelLabel}
                      onPress={() => setToolsMenu("model")}
                      title={t("model")}
                      trailing={
                        <NativeControlGlyph
                          color={theme.color.muted}
                          direction="right"
                          size={16}
                          variant="chevron"
                        />
                      }
                    />
                  ) : null}
                  {model.composerSettingsSupport.permission &&
                  permissionOptions.length > 0 ? (
                    <NativeListRow
                      description={selectedPermissionLabel}
                      onPress={() => setToolsMenu("permission")}
                      title={t("permissions")}
                      trailing={
                        <NativeControlGlyph
                          color={theme.color.muted}
                          direction="right"
                          size={16}
                          variant="chevron"
                        />
                      }
                    />
                  ) : null}
                  {model.composerSettingsSupport.plan ? (
                    <NativeListRow
                      description={
                        model.composerSettings.planMode
                          ? t("planModeOn")
                          : t("planModeOff")
                      }
                      onPress={() => {
                        onUpdate({
                          planMode: !model.composerSettings.planMode
                        });
                        setToolsMenu(null);
                      }}
                      selected={model.composerSettings.planMode === true}
                      title={t("planMode")}
                    />
                  ) : null}
                  {quickPromptLibrary.enabled ? (
                    <NativeListRow
                      description={
                        quickPromptLibrary.status === "loading"
                          ? t("loadingQuickPrompts")
                          : t("quickPromptsCount", {
                              count: quickPromptLibrary.prompts.length
                            })
                      }
                      onPress={() => setToolsMenu("quickPrompts")}
                      title={t("quickPrompts")}
                      trailing={
                        <NativeControlGlyph
                          color={theme.color.muted}
                          direction="right"
                          size={16}
                          variant="chevron"
                        />
                      }
                    />
                  ) : null}
                  {model.composerOptionsLoadStatus === "loading" ? (
                    <ActivityIndicator
                      color={theme.color.accent}
                      size="small"
                      style={styles.loading}
                    />
                  ) : null}
                  {quickPromptLibrary.status === "loading" &&
                  !quickPromptLibrary.enabled ? (
                    <ActivityIndicator
                      color={theme.color.accent}
                      size="small"
                      style={styles.loading}
                    />
                  ) : null}
                  {!hasComposerTools &&
                  quickPromptLibrary.status !== "loading" ? (
                    <Text style={styles.emptyMenu}>
                      {t("noComposerActions")}
                    </Text>
                  ) : null}
                </>
              ) : (
                <>
                  <View style={styles.menuHeader}>
                    <NativeIconButton
                      accessibilityLabel={t("cancel")}
                      icon={
                        <NativeControlGlyph
                          color={theme.color.text}
                          size={20}
                          variant="back"
                        />
                      }
                      onPress={() => setToolsMenu("tools")}
                      style={styles.menuBackButton}
                    />
                    <Text style={styles.menuTitle}>
                      {toolsMenu === "model"
                        ? t("model")
                        : toolsMenu === "permission"
                          ? t("permissions")
                          : t("quickPrompts")}
                    </Text>
                  </View>
                  {toolsMenu === "quickPrompts" ? (
                    <TextInput
                      accessibilityLabel={t("searchQuickPrompts")}
                      autoCapitalize="none"
                      autoCorrect={false}
                      onChangeText={setQuickPromptQuery}
                      placeholder={t("searchQuickPrompts")}
                      placeholderTextColor={theme.color.muted}
                      style={styles.searchInput}
                      value={quickPromptQuery}
                    />
                  ) : null}
                  <ScrollView
                    keyboardDismissMode={mobileKeyboardDismissMode}
                    keyboardShouldPersistTaps="handled"
                    nestedScrollEnabled
                    showsVerticalScrollIndicator
                    style={styles.menuOptions}
                  >
                    {toolsMenu === "model"
                      ? modelOptions.map((option) => (
                          <NativeListRow
                            key={option.value}
                            onPress={() => {
                              onUpdate({ model: option.value });
                              setToolsMenu(null);
                            }}
                            selected={
                              option.value === model.composerSettings.model
                            }
                            title={option.label}
                          />
                        ))
                      : null}
                    {toolsMenu === "permission"
                      ? permissionOptions.map((option) => (
                          <NativeListRow
                            description={option.description}
                            key={option.id}
                            onPress={() => {
                              onUpdate({ permissionModeId: option.id });
                              setToolsMenu(null);
                            }}
                            selected={
                              option.id ===
                              model.composerSettings.permissionModeId
                            }
                            title={option.label ?? option.id}
                          />
                        ))
                      : null}
                    {toolsMenu === "quickPrompts"
                      ? filteredQuickPrompts.map((prompt) => (
                          <NativeListRow
                            description={previewMobileQuickPromptContent(
                              prompt.content
                            )}
                            key={prompt.id}
                            onPress={() => selectQuickPrompt(prompt.content)}
                            title={prompt.title}
                          />
                        ))
                      : null}
                    {toolsMenu === "quickPrompts" &&
                    quickPromptLibrary.status === "error" ? (
                      <View style={styles.quickPromptStatus}>
                        <Text style={styles.errorText}>
                          {t("quickPromptsLoadError")}
                        </Text>
                        <NativeListRow
                          onPress={() => void onRefreshQuickPrompts()}
                          title={t("retry")}
                        />
                      </View>
                    ) : null}
                    {toolsMenu === "quickPrompts" &&
                    quickPromptLibrary.status === "loading" ? (
                      <ActivityIndicator
                        color={theme.color.accent}
                        size="small"
                        style={styles.loading}
                      />
                    ) : null}
                    {toolsMenu === "quickPrompts" &&
                    quickPromptLibrary.status === "ready" &&
                    quickPromptLibrary.prompts.length === 0 ? (
                      <Text style={styles.emptyMenu}>
                        {t("emptyQuickPrompts")}
                      </Text>
                    ) : null}
                    {toolsMenu === "quickPrompts" &&
                    quickPromptLibrary.status === "ready" &&
                    quickPromptLibrary.prompts.length > 0 &&
                    filteredQuickPrompts.length === 0 ? (
                      <Text style={styles.emptyMenu}>
                        {t("noQuickPromptResults")}
                      </Text>
                    ) : null}
                    {toolsMenu !== "quickPrompts" &&
                    model.composerOptionsLoadStatus === "loading" ? (
                      <ActivityIndicator
                        color={theme.color.accent}
                        size="small"
                        style={styles.loading}
                      />
                    ) : null}
                  </ScrollView>
                </>
              )}
            </Pressable>
          </Pressable>
        </MobileKeyboardAvoidingView>
      </Modal>
    </View>
  );
}

function createStyles(theme: NativeTheme) {
  return StyleSheet.create({
    actionButton: {
      alignItems: "center",
      backgroundColor: theme.color.text,
      borderRadius: theme.control.regular / 2,
      height: theme.control.regular,
      justifyContent: "center",
      width: theme.control.regular
    },
    actionRow: {
      alignItems: "center",
      borderTopColor: theme.color.border,
      borderTopWidth: StyleSheet.hairlineWidth,
      flexDirection: "row",
      minHeight: theme.control.regular,
      paddingHorizontal: 4
    },
    actionSlot: {
      alignItems: "center",
      height: theme.control.regular,
      justifyContent: "center",
      width: theme.control.regular
    },
    backdrop: {
      flex: 1,
      justifyContent: "flex-end",
      paddingBottom: theme.control.regular * 2 + theme.space.medium
    },
    addButton: {
      alignItems: "center",
      borderRadius: theme.control.regular / 2,
      height: theme.control.regular,
      justifyContent: "center",
      width: theme.control.regular
    },
    composerShell: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: "hidden",
      width: "100%"
    },
    dock: {
      alignSelf: "center",
      gap: theme.space.small,
      maxWidth: 760 + theme.space.medium * 2,
      paddingBottom: theme.space.small,
      paddingHorizontal: theme.space.medium,
      paddingTop: theme.space.small,
      width: "100%"
    },
    emptyMenu: {
      color: theme.color.muted,
      paddingHorizontal: theme.space.medium,
      paddingVertical: theme.space.large,
      textAlign: "center"
    },
    errorText: {
      color: theme.color.danger,
      paddingHorizontal: theme.space.medium,
      paddingTop: theme.space.small,
      textAlign: "center"
    },
    input: {
      color: theme.color.text,
      flex: 1,
      fontSize: 16,
      lineHeight: 22,
      maxHeight: 120,
      minHeight: theme.control.regular,
      paddingHorizontal: theme.space.medium,
      paddingVertical: 12,
      textAlignVertical: "top"
    },
    inputRow: {
      alignItems: "stretch",
      minHeight: theme.control.regular
    },
    loading: { marginVertical: theme.space.medium },
    menu: {
      backgroundColor: theme.color.panelRaised,
      borderColor: theme.color.border,
      borderRadius: theme.radius.large,
      borderWidth: StyleSheet.hairlineWidth,
      marginHorizontal: theme.space.medium,
      maxHeight: "70%",
      padding: theme.space.small,
      shadowColor: theme.color.text,
      shadowOffset: { height: 10, width: 0 },
      shadowOpacity: 0.16,
      shadowRadius: 24,
      elevation: 12
    },
    modalRoot: { flex: 1 },
    menuBackButton: {
      height: theme.control.regular,
      width: theme.control.regular
    },
    menuHeader: {
      alignItems: "center",
      flexDirection: "row",
      gap: theme.space.small,
      minHeight: theme.control.regular
    },
    menuOptions: { flexShrink: 1 },
    menuTitle: {
      color: theme.color.text,
      fontSize: 17,
      fontWeight: "700",
      paddingRight: theme.space.medium
    },
    quickPromptStatus: {
      gap: theme.space.small
    },
    searchInput: {
      backgroundColor: theme.color.panel,
      borderColor: theme.color.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      color: theme.color.text,
      fontSize: 16,
      marginBottom: theme.space.small,
      minHeight: theme.control.regular,
      paddingHorizontal: theme.space.medium
    },
    settingsRail: { flex: 1, minWidth: 0 }
  });
}
