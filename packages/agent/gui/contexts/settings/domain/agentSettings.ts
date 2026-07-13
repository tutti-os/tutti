import type { AppUpdatePolicy } from "../../../shared/contracts/dto";
import type {
  AgentCustomModelByProvider,
  AgentCustomModelEnabledByProvider,
  AgentCustomModelOptionsByProvider
} from "./agentSettings.customModels";
import {
  AGENT_PROVIDERS,
  isValidProvider,
  normalizeAgentProviderOrder,
  type AgentProvider
} from "./agentSettings.providers";
import {
  normalizeFocusNodeTargetZoom,
  type FocusNodeTargetZoom
} from "./focusNodeTargetZoom";
import {
  isValidUiLanguage,
  isValidUiTheme,
  type UiLanguage,
  type UiTheme
} from "./uiSettings";
import { isValidUpdatePolicy } from "./updateSettings";
import type { KeybindingOverrides } from "./keybindings";
import { normalizeKeybindingOverrides } from "./keybindings";
import {
  isValidCanvasInputMode,
  isValidCanvasWheelBehavior,
  isValidCanvasWheelZoomModifier,
  isValidStandardWindowSizeBucket,
  type CanvasInputMode,
  type CanvasWheelBehavior,
  type CanvasWheelZoomModifier,
  type StandardWindowSizeBucket
} from "./canvasSettings";
import {
  isRecord,
  normalizeBoolean,
  normalizeIntegerInRange,
  normalizeTextValue,
  normalizeUniqueStringArray
} from "./settingsNormalization";
import type { QuickCommand } from "./quickCommands";
import { normalizeQuickCommands } from "./quickCommands";
import type { QuickPhrase } from "./quickPhrases";
import { normalizeQuickPhrases } from "./quickPhrases";
import type { AgentEnvByProvider } from "./agentEnv";
import { normalizeAgentEnvByProvider } from "./agentEnv";
import { DEFAULT_AGENT_SETTINGS } from "./agentSettings.defaults";

export {
  FOCUS_NODE_TARGET_ZOOM_STEP,
  MAX_FOCUS_NODE_TARGET_ZOOM,
  MIN_FOCUS_NODE_TARGET_ZOOM
} from "./focusNodeTargetZoom";
export type { FocusNodeTargetZoom } from "./focusNodeTargetZoom";
export {
  AGENT_PROVIDERS,
  EXPERIMENTAL_AGENT_PROVIDERS
} from "./agentSettings.providers";
export type { AgentProvider } from "./agentSettings.providers";
export {
  CANVAS_INPUT_MODES,
  CANVAS_WHEEL_BEHAVIORS,
  CANVAS_WHEEL_ZOOM_MODIFIERS,
  STANDARD_WINDOW_SIZE_BUCKETS
} from "./canvasSettings";
export type {
  CanvasInputMode,
  CanvasWheelBehavior,
  CanvasWheelZoomModifier,
  StandardWindowSizeBucket
} from "./canvasSettings";
export {
  DEFAULT_UI_LANGUAGE,
  DEFAULT_UI_THEME,
  UI_LANGUAGES,
  UI_THEMES
} from "./uiSettings";
export type { UiLanguage, UiTheme } from "./uiSettings";

export type TerminalProfileId = string | null;
export const MIN_DEFAULT_TERMINAL_WINDOW_SCALE_PERCENT = 60;
export const MAX_DEFAULT_TERMINAL_WINDOW_SCALE_PERCENT = 120;
export const MIN_TERMINAL_FONT_SIZE = 10;
export const MAX_TERMINAL_FONT_SIZE = 22;
export const MIN_UI_FONT_SIZE = 14;
export const MAX_UI_FONT_SIZE = 24;

export {
  AGENT_PROVIDER_CAPABILITIES,
  AGENT_PROVIDER_LABEL,
  type AgentProviderCapabilities
} from "./agentSettings.providerMeta";
export { UI_LANGUAGE_NATIVE_LABEL } from "./agentSettings.uiLanguage";

export type { QuickCommand } from "./quickCommands";
export type { QuickPhrase } from "./quickPhrases";
export type { AgentEnvByProvider, AgentEnvRow } from "./agentEnv";
export {
  resolveAgentLaunchEnv,
  resolveAgentModel
} from "./agentSettings.resolvers";

export interface AgentSettings {
  language: UiLanguage;
  uiTheme: UiTheme;
  isPrimarySidebarCollapsed: boolean;
  defaultProvider: AgentProvider;
  agentProviderOrder: AgentProvider[];
  agentFullAccess: boolean;
  defaultTerminalProfileId: TerminalProfileId;
  customModelEnabledByProvider: AgentCustomModelEnabledByProvider<AgentProvider>;
  customModelByProvider: AgentCustomModelByProvider<AgentProvider>;
  customModelOptionsByProvider: AgentCustomModelOptionsByProvider<AgentProvider>;
  quickCommands: QuickCommand[];
  quickPhrases: QuickPhrase[];
  agentEnvByProvider: AgentEnvByProvider;
  focusNodeOnClick: boolean;
  focusNodeTargetZoom: FocusNodeTargetZoom;
  focusNodeUseVisibleCanvasCenter: boolean;
  standbyBannerEnabled: boolean;
  standbyBannerShowTask: boolean;
  standbyBannerShowSpace: boolean;
  standbyBannerShowBranch: boolean;
  disableAppShortcutsWhenTerminalFocused: boolean;
  keybindings: KeybindingOverrides;
  canvasInputMode: CanvasInputMode;
  canvasWheelBehavior: CanvasWheelBehavior;
  canvasWheelZoomModifier: CanvasWheelZoomModifier;
  standardWindowSizeBucket: StandardWindowSizeBucket;
  defaultTerminalWindowScalePercent: number;
  terminalFontSize: number;
  terminalFontFamily: string | null;
  uiFontSize: number;
  avoidGroupingEdits: boolean;
  updatePolicy: AppUpdatePolicy;
  hideWorktreeMismatchDropWarning: boolean;
}
export { DEFAULT_AGENT_SETTINGS };

export function normalizeAgentSettings(value: unknown): AgentSettings {
  if (!isRecord(value)) {
    return DEFAULT_AGENT_SETTINGS;
  }

  const defaultProvider = isValidProvider(value.defaultProvider)
    ? value.defaultProvider
    : DEFAULT_AGENT_SETTINGS.defaultProvider;
  const language = isValidUiLanguage(value.language)
    ? value.language
    : DEFAULT_AGENT_SETTINGS.language;
  const uiTheme: UiTheme = isValidUiTheme(value.uiTheme)
    ? value.uiTheme
    : DEFAULT_AGENT_SETTINGS.uiTheme;
  const isPrimarySidebarCollapsed =
    normalizeBoolean(value.isPrimarySidebarCollapsed) ??
    DEFAULT_AGENT_SETTINGS.isPrimarySidebarCollapsed;
  const agentProviderOrder = normalizeAgentProviderOrder(
    value.agentProviderOrder
  );

  const agentFullAccess = true;
  const defaultTerminalProfileId = normalizeTextValue(
    value.defaultTerminalProfileId
  );

  const enabledInput = isRecord(value.customModelEnabledByProvider)
    ? value.customModelEnabledByProvider
    : {};

  const customModelInput = isRecord(value.customModelByProvider)
    ? value.customModelByProvider
    : {};

  const customModelEnabledByProvider = AGENT_PROVIDERS.reduce<
    AgentCustomModelEnabledByProvider<AgentProvider>
  >(
    (acc, provider) => {
      const normalizedEnabled = normalizeBoolean(enabledInput[provider]);

      acc[provider] =
        normalizedEnabled === null ? acc[provider] : normalizedEnabled;

      return acc;
    },
    { ...DEFAULT_AGENT_SETTINGS.customModelEnabledByProvider }
  );

  const customModelByProvider = AGENT_PROVIDERS.reduce<
    AgentCustomModelByProvider<AgentProvider>
  >(
    (acc, provider) => {
      acc[provider] = normalizeTextValue(customModelInput[provider]);
      return acc;
    },
    { ...DEFAULT_AGENT_SETTINGS.customModelByProvider }
  );

  const optionsInput = isRecord(value.customModelOptionsByProvider)
    ? value.customModelOptionsByProvider
    : {};

  const customModelOptionsByProvider = AGENT_PROVIDERS.reduce<
    AgentCustomModelOptionsByProvider<AgentProvider>
  >(
    (acc, provider) => {
      const options = normalizeUniqueStringArray(optionsInput[provider]);
      const selectedModel = customModelByProvider[provider];

      if (selectedModel.length > 0 && !options.includes(selectedModel)) {
        options.unshift(selectedModel);
      }

      acc[provider] = options;
      return acc;
    },
    AGENT_PROVIDERS.reduce<AgentCustomModelOptionsByProvider<AgentProvider>>(
      (acc, provider) => {
        acc[provider] = [
          ...DEFAULT_AGENT_SETTINGS.customModelOptionsByProvider[provider]
        ];
        return acc;
      },
      { ...DEFAULT_AGENT_SETTINGS.customModelOptionsByProvider }
    )
  );

  const quickCommands = normalizeQuickCommands(value.quickCommands);
  const quickPhrases = normalizeQuickPhrases(value.quickPhrases);
  const agentEnvByProvider = normalizeAgentEnvByProvider(
    value.agentEnvByProvider
  );
  const focusNodeOnClick =
    normalizeBoolean(value.focusNodeOnClick) ??
    DEFAULT_AGENT_SETTINGS.focusNodeOnClick;
  const focusNodeTargetZoom = normalizeFocusNodeTargetZoom(
    value.focusNodeTargetZoom,
    DEFAULT_AGENT_SETTINGS.focusNodeTargetZoom
  );
  const focusNodeUseVisibleCanvasCenter =
    normalizeBoolean(value.focusNodeUseVisibleCanvasCenter) ??
    DEFAULT_AGENT_SETTINGS.focusNodeUseVisibleCanvasCenter;
  const standbyBannerEnabled =
    normalizeBoolean(value.standbyBannerEnabled) ??
    DEFAULT_AGENT_SETTINGS.standbyBannerEnabled;
  const standbyBannerShowTask =
    normalizeBoolean(value.standbyBannerShowTask) ??
    DEFAULT_AGENT_SETTINGS.standbyBannerShowTask;
  const standbyBannerShowSpace =
    normalizeBoolean(value.standbyBannerShowSpace) ??
    DEFAULT_AGENT_SETTINGS.standbyBannerShowSpace;
  const standbyBannerShowBranch =
    normalizeBoolean(value.standbyBannerShowBranch) ??
    DEFAULT_AGENT_SETTINGS.standbyBannerShowBranch;
  const disableAppShortcutsWhenTerminalFocused =
    normalizeBoolean(value.disableAppShortcutsWhenTerminalFocused) ??
    DEFAULT_AGENT_SETTINGS.disableAppShortcutsWhenTerminalFocused;
  const keybindings = normalizeKeybindingOverrides(value.keybindings);
  const canvasInputMode = isValidCanvasInputMode(value.canvasInputMode)
    ? value.canvasInputMode
    : DEFAULT_AGENT_SETTINGS.canvasInputMode;
  const canvasWheelBehavior = isValidCanvasWheelBehavior(
    value.canvasWheelBehavior
  )
    ? value.canvasWheelBehavior
    : DEFAULT_AGENT_SETTINGS.canvasWheelBehavior;
  const canvasWheelZoomModifier = isValidCanvasWheelZoomModifier(
    value.canvasWheelZoomModifier
  )
    ? value.canvasWheelZoomModifier
    : DEFAULT_AGENT_SETTINGS.canvasWheelZoomModifier;
  const standardWindowSizeBucket = isValidStandardWindowSizeBucket(
    value.standardWindowSizeBucket
  )
    ? value.standardWindowSizeBucket
    : DEFAULT_AGENT_SETTINGS.standardWindowSizeBucket;
  const defaultTerminalWindowScalePercent = normalizeIntegerInRange(
    value.defaultTerminalWindowScalePercent,
    DEFAULT_AGENT_SETTINGS.defaultTerminalWindowScalePercent,
    MIN_DEFAULT_TERMINAL_WINDOW_SCALE_PERCENT,
    MAX_DEFAULT_TERMINAL_WINDOW_SCALE_PERCENT
  );
  const terminalFontSize = normalizeIntegerInRange(
    value.terminalFontSize,
    DEFAULT_AGENT_SETTINGS.terminalFontSize,
    MIN_TERMINAL_FONT_SIZE,
    MAX_TERMINAL_FONT_SIZE
  );
  const terminalFontFamily =
    typeof value.terminalFontFamily === "string" &&
    value.terminalFontFamily.trim().length > 0
      ? value.terminalFontFamily.trim()
      : DEFAULT_AGENT_SETTINGS.terminalFontFamily;
  const uiFontSize = normalizeIntegerInRange(
    value.uiFontSize,
    DEFAULT_AGENT_SETTINGS.uiFontSize,
    MIN_UI_FONT_SIZE,
    MAX_UI_FONT_SIZE
  );
  const avoidGroupingEdits =
    normalizeBoolean(value.avoidGroupingEdits) ??
    DEFAULT_AGENT_SETTINGS.avoidGroupingEdits;
  const updatePolicy = isValidUpdatePolicy(value.updatePolicy)
    ? value.updatePolicy
    : DEFAULT_AGENT_SETTINGS.updatePolicy;
  const hideWorktreeMismatchDropWarning =
    normalizeBoolean(value.hideWorktreeMismatchDropWarning) ??
    DEFAULT_AGENT_SETTINGS.hideWorktreeMismatchDropWarning;

  return {
    language,
    uiTheme,
    isPrimarySidebarCollapsed,
    defaultProvider,
    agentProviderOrder,
    agentFullAccess,
    defaultTerminalProfileId:
      defaultTerminalProfileId.length > 0
        ? defaultTerminalProfileId
        : DEFAULT_AGENT_SETTINGS.defaultTerminalProfileId,
    customModelEnabledByProvider,
    customModelByProvider,
    customModelOptionsByProvider,
    quickCommands,
    quickPhrases,
    agentEnvByProvider,
    focusNodeOnClick,
    focusNodeTargetZoom,
    focusNodeUseVisibleCanvasCenter,
    standbyBannerEnabled,
    standbyBannerShowTask,
    standbyBannerShowSpace,
    standbyBannerShowBranch,
    disableAppShortcutsWhenTerminalFocused,
    keybindings,
    canvasInputMode,
    canvasWheelBehavior,
    canvasWheelZoomModifier,
    standardWindowSizeBucket,
    defaultTerminalWindowScalePercent,
    terminalFontSize,
    terminalFontFamily,
    uiFontSize,
    avoidGroupingEdits,
    updatePolicy,
    hideWorktreeMismatchDropWarning
  };
}
