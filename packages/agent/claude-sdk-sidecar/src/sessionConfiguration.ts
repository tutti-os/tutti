import type { PermissionMode, Settings } from "@anthropic-ai/claude-agent-sdk";
import { booleanValue, stringValue } from "./runtimeValues.ts";
import {
  canBypassPermissions,
  defaultSidecarModelOptionValue,
  effortLevelValue,
  flagSettingsFromSessionSettings,
  permissionModeValue,
  sidecarModelOptionsFromInitializationResult,
  type PendingFlagSettings,
  type SidecarConfigOption,
  type SidecarSessionSettings
} from "./sessionSettings.ts";

export type ConfigurableClaudeQuery = {
  initializationResult?: () => Promise<unknown>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: PendingFlagSettings) => Promise<void>;
};

export class SessionConfiguration {
  readonly settings: SidecarSessionSettings;
  private configOptions: SidecarConfigOption[] = [];
  private pendingFlagSettings: PendingFlagSettings = {};
  private readonly getQuery: () => ConfigurableClaudeQuery | undefined;
  private readonly testDriver: boolean;
  private readonly isInitialized: () => boolean;
  private readonly markInitialized: () => void;
  private readonly emitFastModeState: (state: "on" | "off") => void;

  constructor(options: {
    settings: SidecarSessionSettings;
    getQuery: () => ConfigurableClaudeQuery | undefined;
    testDriver: boolean;
    isInitialized: () => boolean;
    markInitialized: () => void;
    emitFastModeState: (state: "on" | "off") => void;
  }) {
    this.settings = options.settings;
    this.getQuery = options.getQuery;
    this.testDriver = options.testDriver;
    this.isInitialized = options.isInitialized;
    this.markInitialized = options.markInitialized;
    this.emitFastModeState = options.emitFastModeState;
    this.mergePendingFlagSettings(
      flagSettingsFromSessionSettings(options.settings)
    );
  }

  async apply(payload: Record<string, unknown>): Promise<void> {
    if (Object.hasOwn(payload, "planMode")) {
      this.settings.planMode = booleanValue(payload.planMode);
    }
    if (Object.hasOwn(payload, "permissionMode")) {
      await this.applyPermissionMode(stringValue(payload.permissionMode));
    }
    if (Object.hasOwn(payload, "model")) {
      await this.applyModel(stringValue(payload.model));
    }
    if (Object.hasOwn(payload, "effort")) {
      await this.applyEffort(stringValue(payload.effort));
    }
    if (Object.hasOwn(payload, "speed")) {
      const speed = stringValue(payload.speed);
      if (speed === "fast" || speed === "standard") {
        await this.applyFastMode(speed === "fast");
      }
    }
  }

  async applyPendingFlags(): Promise<void> {
    if (Object.keys(this.pendingFlagSettings).length === 0) {
      return;
    }
    if (this.testDriver) {
      const enabled = this.pendingFlagSettings.fastMode;
      this.pendingFlagSettings = {};
      if (typeof enabled === "boolean") {
        this.emitFastModeState(enabled ? "on" : "off");
      }
      return;
    }
    const query = this.getQuery();
    if (!query) {
      return;
    }
    if (typeof query.applyFlagSettings !== "function") {
      throw new Error("Claude SDK runtime does not support live flag settings");
    }
    if (!this.isInitialized() && query.initializationResult) {
      await query.initializationResult();
      this.markInitialized();
    }
    const settings = this.pendingFlagSettings;
    this.pendingFlagSettings = {};
    await query.applyFlagSettings(settings);
    if (typeof settings.fastMode === "boolean") {
      this.emitFastModeState(settings.fastMode ? "on" : "off");
    }
  }

  applyInitializationResult(value: unknown): void {
    const result = recordValue(value);
    if (!result) {
      return;
    }
    const modelOptions = sidecarModelOptionsFromInitializationResult(result);
    if (modelOptions.length === 0) {
      return;
    }
    const currentModel =
      this.resolveModelOptionValue(this.settings.model) ||
      defaultSidecarModelOptionValue(modelOptions);
    this.settings.model = currentModel;
    this.configOptions = [
      {
        id: "model",
        name: "Model",
        description: "AI model to use",
        category: "model",
        type: "select",
        currentValue: currentModel || "default",
        options: modelOptions
      }
    ];
  }

  sessionStatePayload(): Record<string, unknown> {
    return {
      ...(this.settings.model ? { model: this.settings.model } : {}),
      ...(this.configOptions.length > 0
        ? { configOptions: this.configOptions }
        : {})
    };
  }

  private async applyPermissionMode(mode: string): Promise<void> {
    let permissionMode = permissionModeValue(mode);
    if (!permissionMode) {
      return;
    }
    if (permissionMode === "bypassPermissions" && !canBypassPermissions()) {
      permissionMode = "default";
    }
    if (permissionMode === "plan") {
      this.settings.planMode = true;
    } else {
      this.settings.planMode = false;
      this.settings.permissionModeId = permissionMode;
    }
    const query = this.getQuery();
    if (this.testDriver || !query) {
      return;
    }
    if (typeof query.setPermissionMode !== "function") {
      throw new Error(
        "Claude SDK runtime does not support live permission mode settings"
      );
    }
    await query.setPermissionMode(permissionMode);
  }

  private async applyModel(model: string): Promise<void> {
    const resolvedModel = this.resolveModelOptionValue(model);
    this.settings.model = resolvedModel;
    const query = this.getQuery();
    if (this.testDriver || !query) {
      return;
    }
    if (typeof query.setModel !== "function") {
      throw new Error(
        "Claude SDK runtime does not support live model settings"
      );
    }
    await query.setModel(
      resolvedModel === "" || resolvedModel === "default"
        ? undefined
        : resolvedModel
    );
    this.updateConfigOptionCurrentValue("model", resolvedModel || "default");
  }

  private async applyEffort(effort: string): Promise<void> {
    this.settings.effort = effort;
    this.mergePendingFlagSettings({ effortLevel: effortLevelValue(effort) });
    await this.applyPendingFlags();
  }

  private async applyFastMode(enabled: boolean): Promise<void> {
    this.settings.speed = enabled ? "fast" : "standard";
    this.mergePendingFlagSettings({ fastMode: enabled });
    await this.applyPendingFlags();
  }

  private resolveModelOptionValue(model: string): string {
    const requested = stringValue(model);
    if (!requested) {
      return "";
    }
    const modelOption = this.configOptions.find(
      (option) => option.id === "model"
    );
    if (!modelOption) {
      return requested;
    }
    const exact = modelOption.options.find(
      (option) => option.value === requested
    );
    if (exact) {
      return exact.value;
    }
    const lower = requested.toLowerCase();
    const matched = modelOption.options.find((option) => {
      const value = option.value.toLowerCase();
      const name = option.name.toLowerCase();
      return value === lower || name === lower;
    });
    return matched?.value ?? requested;
  }

  private updateConfigOptionCurrentValue(id: string, value: string): void {
    this.configOptions = this.configOptions.map((option) =>
      option.id === id ? { ...option, currentValue: value } : option
    );
  }

  private mergePendingFlagSettings(settings: PendingFlagSettings): void {
    for (const [key, value] of Object.entries(settings) as Array<
      [keyof Settings, Settings[keyof Settings] | null | undefined]
    >) {
      if (value !== undefined) {
        this.pendingFlagSettings[key] = value;
      }
    }
  }
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
