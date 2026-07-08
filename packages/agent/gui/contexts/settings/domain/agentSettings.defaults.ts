import { AGENT_PROVIDERS } from "./agentSettings.providers";
import type { AgentSettings } from "./agentSettings";
import { DEFAULT_AGENT_ENV_BY_PROVIDER } from "./agentEnv";
import { DEFAULT_UI_LANGUAGE, DEFAULT_UI_THEME } from "./uiSettings";

export const DEFAULT_AGENT_SETTINGS: AgentSettings = {
  language: DEFAULT_UI_LANGUAGE,
  uiTheme: DEFAULT_UI_THEME,
  isPrimarySidebarCollapsed: false,
  defaultProvider: "codex",
  agentProviderOrder: [...AGENT_PROVIDERS],
  agentFullAccess: true,
  defaultTerminalProfileId: null,
  customModelEnabledByProvider: {
    "claude-code": false,
    codex: false,
    "tutti-agent": false,
    cursor: false,
    nexight: false,
    opencode: false,
    openclaw: false,
    hermes: false
  },
  customModelByProvider: {
    "claude-code": "",
    codex: "",
    "tutti-agent": "",
    cursor: "",
    nexight: "",
    opencode: "",
    openclaw: "",
    hermes: ""
  },
  customModelOptionsByProvider: {
    "claude-code": [],
    codex: [],
    "tutti-agent": [],
    cursor: [],
    nexight: [],
    opencode: [],
    openclaw: [],
    hermes: []
  },
  quickCommands: [],
  quickPhrases: [],
  agentEnvByProvider: DEFAULT_AGENT_ENV_BY_PROVIDER,
  focusNodeOnClick: false,
  focusNodeTargetZoom: 1,
  focusNodeUseVisibleCanvasCenter: true,
  standbyBannerEnabled: true,
  standbyBannerShowTask: true,
  standbyBannerShowSpace: true,
  standbyBannerShowBranch: true,
  disableAppShortcutsWhenTerminalFocused: true,
  keybindings: {},
  canvasInputMode: "auto",
  canvasWheelBehavior: "zoom",
  canvasWheelZoomModifier: "primary",
  standardWindowSizeBucket: "regular",
  defaultTerminalWindowScalePercent: 80,
  terminalFontSize: 13,
  terminalFontFamily: null,
  uiFontSize: 18,
  avoidGroupingEdits: false,
  updatePolicy: "prompt",
  hideWorktreeMismatchDropWarning: false
};
