import { ObservableService } from "./observableService";

export interface ComposerDraftSnapshot {
  drafts: Readonly<Record<string, string>>;
}

export class ComposerDraftService extends ObservableService<ComposerDraftSnapshot> {
  readonly _serviceBrand: undefined;
  private snapshot: ComposerDraftSnapshot = { drafts: {} };

  getSnapshot = (): ComposerDraftSnapshot => this.snapshot;

  get(key: string): string {
    return this.snapshot.drafts[key] ?? "";
  }

  set(key: string, value: string): void {
    if (this.get(key) === value) return;
    this.snapshot = {
      drafts: { ...this.snapshot.drafts, [key]: value }
    };
    this.emitChange();
  }

  clear(key: string): void {
    if (!(key in this.snapshot.drafts)) return;
    const drafts = { ...this.snapshot.drafts };
    delete drafts[key];
    this.snapshot = { drafts };
    this.emitChange();
  }

  dispose(): void {
    this.clearListeners();
  }
}
