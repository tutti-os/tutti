import type { AgentActivitySessionSettings } from "@tutti-os/agent-activity-core";
import { ObservableService } from "./observableService";

export interface ComposerDraftSnapshot {
  drafts: Readonly<Record<string, string>>;
  settingsByTargetId: Readonly<Record<string, AgentActivitySessionSettings>>;
}

export class ComposerDraftService extends ObservableService<ComposerDraftSnapshot> {
  readonly _serviceBrand: undefined;
  private snapshot: ComposerDraftSnapshot = {
    drafts: {},
    settingsByTargetId: {}
  };

  getSnapshot = (): ComposerDraftSnapshot => this.snapshot;

  get(key: string): string {
    return this.snapshot.drafts[key] ?? "";
  }

  set(key: string, value: string): void {
    if (this.get(key) === value) return;
    this.snapshot = {
      ...this.snapshot,
      drafts: { ...this.snapshot.drafts, [key]: value }
    };
    this.emitChange();
  }

  clear(key: string): void {
    if (!(key in this.snapshot.drafts)) return;
    const drafts = { ...this.snapshot.drafts };
    delete drafts[key];
    this.snapshot = { ...this.snapshot, drafts };
    this.emitChange();
  }

  getSettings(agentTargetId: string): AgentActivitySessionSettings {
    return this.snapshot.settingsByTargetId[agentTargetId] ?? {};
  }

  setSettings(
    agentTargetId: string,
    settings: AgentActivitySessionSettings
  ): void {
    const targetId = agentTargetId.trim();
    if (!targetId) return;
    const previous = this.getSettings(targetId);
    const next = { ...previous, ...settings };
    if (
      Object.keys(next).every(
        (key) =>
          next[key as keyof AgentActivitySessionSettings] ===
          previous[key as keyof AgentActivitySessionSettings]
      ) &&
      Object.keys(previous).length === Object.keys(next).length
    ) {
      return;
    }
    this.snapshot = {
      ...this.snapshot,
      settingsByTargetId: {
        ...this.snapshot.settingsByTargetId,
        [targetId]: next
      }
    };
    this.emitChange();
  }

  dispose(): void {
    this.clearListeners();
  }
}
