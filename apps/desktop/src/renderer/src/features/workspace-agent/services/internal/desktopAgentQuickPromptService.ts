import type {
  AgentHostQuickPrompt,
  AgentHostQuickPromptSnapshot
} from "@tutti-os/agent-gui";
import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import { subscribe as subscribeValtio } from "valtio";
import {
  AGENT_QUICK_PROMPT_LIBRARY_FLAG,
  isFeatureEnabled
} from "../../../../../../shared/featureFlags/catalog.ts";
import type { IDesktopPreferencesService } from "../../../desktop-preferences/services/desktopPreferencesService.interface.ts";
import type { IAgentQuickPromptService } from "../agentQuickPromptService.interface.ts";

const disabledErrorCode = "quick_prompts.disabled";

export class DesktopAgentQuickPromptService implements IAgentQuickPromptService {
  readonly _serviceBrand = undefined;

  private readonly listeners = new Set<
    (snapshot: AgentHostQuickPromptSnapshot) => void
  >();
  private readonly pendingMutationCounts = new Map<string, number>();
  private readonly locallyAppliedEvents = new Set<string>();
  private readonly disposePreferencesSubscription: () => void;
  private readonly disposeEventSubscription: (() => void) | null;
  private snapshot: AgentHostQuickPromptSnapshot;
  private loadPromise: Promise<void> | null = null;
  private loadGeneration = 0;
  private refreshRequestedDuringLoad = false;
  private eventRefreshQueued = false;
  private disposed = false;
  private mutationSequence = 0;
  private readonly input: {
    desktopPreferencesService: IDesktopPreferencesService;
    eventStreamClient?: TuttidEventStreamClient;
    tuttidClient: TuttidClient;
  };

  constructor(input: {
    desktopPreferencesService: IDesktopPreferencesService;
    eventStreamClient?: TuttidEventStreamClient;
    tuttidClient: TuttidClient;
  }) {
    this.input = input;
    this.snapshot = {
      enabled: this.readEnabled(),
      error: null,
      pendingMutationIds: [],
      orderMutationPending: false,
      prompts: [],
      revision: 0,
      status: "idle"
    };
    this.disposePreferencesSubscription = subscribeValtio(
      input.desktopPreferencesService.store,
      () => this.handlePreferencesChanged()
    );
    this.disposeEventSubscription = input.eventStreamClient
      ? input.eventStreamClient.subscribe(
          "agent.quickprompt.updated",
          (event) => this.handleQuickPromptEvent(event.payload),
          { scope: null }
        )
      : null;
    if (input.eventStreamClient) {
      void input.eventStreamClient.connect().catch(() => {});
    }
  }

  readonly getSnapshot = (): AgentHostQuickPromptSnapshot => {
    return this.snapshot;
  };

  readonly subscribe = (
    listener: (snapshot: AgentHostQuickPromptSnapshot) => void
  ): (() => void) => {
    if (this.disposed) return () => {};
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  async ensureLoaded(input?: { force?: boolean }): Promise<void> {
    this.assertEnabled();
    if (!input?.force && this.snapshot.status === "ready") return;
    if (this.loadPromise) {
      if (input?.force || this.snapshot.status === "idle") {
        this.refreshRequestedDuringLoad = true;
      }
      return this.loadPromise;
    }

    const loadPromise = this.load();
    this.loadPromise = loadPromise;
    try {
      await loadPromise;
    } finally {
      if (this.loadPromise === loadPromise) this.loadPromise = null;
    }
  }

  async create(input: {
    title: string;
    content: string;
  }): Promise<AgentHostQuickPrompt> {
    this.assertEnabled();
    const mutationId = `create:${++this.mutationSequence}`;
    return this.runMutation(mutationId, "create", async () => {
      const response = await this.input.tuttidClient.createAgentQuickPrompt({
        content: input.content,
        title: input.title
      });
      return toHostQuickPrompt(response);
    });
  }

  async update(input: {
    id: string;
    title: string;
    content: string;
    expectedVersion: number;
  }): Promise<AgentHostQuickPrompt> {
    this.assertEnabled();
    return this.runMutation(input.id, "update", async () => {
      const response = await this.input.tuttidClient.updateAgentQuickPrompt(
        input.id,
        {
          content: input.content,
          expectedVersion: input.expectedVersion,
          title: input.title
        }
      );
      return toHostQuickPrompt(response);
    });
  }

  async remove(input: { id: string; expectedVersion: number }): Promise<void> {
    this.assertEnabled();
    await this.runMutation(input.id, "delete", async () => {
      await this.input.tuttidClient.deleteAgentQuickPrompt(input.id, {
        expectedVersion: input.expectedVersion
      });
    });
  }

  async move(input: {
    promptId: string;
    beforePromptId: string | null;
    expectedVersion: number;
  }): Promise<readonly AgentHostQuickPrompt[]> {
    this.assertEnabled();
    if (this.snapshot.orderMutationPending) {
      throw new Error("quick_prompts.move_pending");
    }
    const originalPrompts = this.snapshot.prompts;
    const optimisticPrompts = movePromptBefore(
      originalPrompts,
      input.promptId,
      input.beforePromptId
    );
    this.incrementPendingMutation(input.promptId);
    this.publish({
      error: null,
      orderMutationPending: true,
      pendingMutationIds: [...this.pendingMutationCounts.keys()],
      prompts: optimisticPrompts
    });
    try {
      const response =
        await this.input.tuttidClient.moveAgentQuickPrompt(input);
      const prompts = response.prompts.map(toHostQuickPrompt);
      this.markDataChangedDuringLoad();
      const movedPrompt = prompts.find(
        (prompt) => prompt.id === input.promptId
      );
      if (movedPrompt) {
        this.rememberLocallyAppliedEvent(
          movedPrompt.id,
          "update",
          movedPrompt.version
        );
      }
      if (!this.disposed && this.readEnabled()) {
        this.publish({ error: null, prompts, status: "ready" });
      }
      return prompts;
    } catch (error) {
      if (!this.disposed && this.readEnabled()) {
        if (promptSnapshotsEqual(this.snapshot.prompts, optimisticPrompts)) {
          this.publish({
            error: "quick_prompts.move_failed",
            prompts: originalPrompts
          });
        } else {
          this.publish({ error: "quick_prompts.move_failed" });
        }
        void this.ensureLoaded({ force: true }).catch(() => {});
      }
      throw error;
    } finally {
      this.decrementPendingMutation(input.promptId);
      this.publish({
        orderMutationPending: false,
        pendingMutationIds: [...this.pendingMutationCounts.keys()]
      });
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.disposePreferencesSubscription();
    this.disposeEventSubscription?.();
    this.listeners.clear();
  }

  private async load(): Promise<void> {
    this.publish({ error: null, status: "loading" });
    while (!this.disposed && this.readEnabled()) {
      this.refreshRequestedDuringLoad = false;
      const generation = this.loadGeneration;
      try {
        const response = await this.input.tuttidClient.listAgentQuickPrompts();
        if (this.disposed || !this.readEnabled()) return;
        if (
          this.refreshRequestedDuringLoad ||
          generation !== this.loadGeneration
        ) {
          if (this.refreshRequestedDuringLoad) continue;
          return;
        }
        const prompts = response.prompts.map(toHostQuickPrompt);
        this.publish({ error: null, prompts, status: "ready" });
        return;
      } catch (error) {
        if (!this.disposed && this.readEnabled()) {
          this.publish({
            error: "quick_prompts.load_failed",
            status: "error"
          });
        }
        throw error;
      }
    }
  }

  private async runMutation<T>(
    mutationId: string,
    kind: "create" | "update" | "delete",
    operation: () => Promise<T>
  ): Promise<T> {
    this.incrementPendingMutation(mutationId);
    this.publishPendingMutations();
    try {
      const result = await operation();
      this.markDataChangedDuringLoad();
      if (this.disposed || !this.readEnabled()) return result;
      if (kind === "delete") {
        this.rememberLocallyAppliedEvent(mutationId, kind, null);
        this.publish({
          error: null,
          prompts: this.snapshot.prompts.filter(
            (prompt) => prompt.id !== mutationId
          ),
          status: "ready"
        });
      } else {
        const prompt = result as AgentHostQuickPrompt;
        this.rememberLocallyAppliedEvent(prompt.id, kind, prompt.version);
        const prompts =
          kind === "create"
            ? [
                prompt,
                ...this.snapshot.prompts.filter(
                  (candidate) => candidate.id !== prompt.id
                )
              ]
            : this.snapshot.prompts.map((candidate) =>
                candidate.id === prompt.id ? prompt : candidate
              );
        this.publish({ error: null, prompts, status: "ready" });
      }
      return result;
    } catch (error) {
      this.publish({ error: `quick_prompts.${kind}_failed` });
      throw error;
    } finally {
      this.decrementPendingMutation(mutationId);
      this.publishPendingMutations();
    }
  }

  private scheduleEventRefresh(): void {
    if (
      this.disposed ||
      !this.readEnabled() ||
      this.snapshot.status === "idle" ||
      this.eventRefreshQueued
    ) {
      return;
    }
    this.eventRefreshQueued = true;
    queueMicrotask(() => {
      this.eventRefreshQueued = false;
      if (this.disposed || !this.readEnabled()) return;
      void this.ensureLoaded({ force: true }).catch(() => {});
    });
  }

  private handleQuickPromptEvent(payload: {
    promptId: string;
    changeKind: "created" | "updated" | "deleted";
    version: number;
  }): void {
    const key = quickPromptEventKey(
      payload.promptId,
      payload.changeKind,
      payload.version
    );
    if (this.locallyAppliedEvents.delete(key)) return;
    this.scheduleEventRefresh();
  }

  private rememberLocallyAppliedEvent(
    promptId: string,
    kind: "create" | "update" | "delete",
    version: number | null
  ): void {
    const changeKind =
      kind === "create" ? "created" : kind === "update" ? "updated" : "deleted";
    const resolvedVersion =
      version ??
      this.snapshot.prompts.find((prompt) => prompt.id === promptId)?.version;
    if (resolvedVersion === undefined) return;
    this.locallyAppliedEvents.add(
      quickPromptEventKey(promptId, changeKind, resolvedVersion)
    );
    if (this.locallyAppliedEvents.size > 128) {
      const oldest = this.locallyAppliedEvents.values().next().value;
      if (oldest) this.locallyAppliedEvents.delete(oldest);
    }
  }

  private handlePreferencesChanged(): void {
    const enabled = this.readEnabled();
    if (enabled === this.snapshot.enabled) return;
    if (!enabled) {
      this.loadGeneration++;
      this.refreshRequestedDuringLoad = false;
      this.pendingMutationCounts.clear();
      this.locallyAppliedEvents.clear();
      this.publish({
        enabled: false,
        error: null,
        pendingMutationIds: [],
        orderMutationPending: false,
        status: "idle"
      });
      return;
    }
    this.publish({ enabled: true, error: null, status: "idle" });
  }

  private readEnabled(): boolean {
    const store = this.input.desktopPreferencesService.store;
    const flags = store.changingFeatureFlags ?? store.featureFlags;
    return isFeatureEnabled(flags, AGENT_QUICK_PROMPT_LIBRARY_FLAG);
  }

  private assertEnabled(): void {
    if (this.disposed || !this.readEnabled()) {
      throw new Error(disabledErrorCode);
    }
  }

  private publishPendingMutations(): void {
    this.publish({
      pendingMutationIds: [...this.pendingMutationCounts.keys()]
    });
  }

  private incrementPendingMutation(mutationId: string): void {
    this.pendingMutationCounts.set(
      mutationId,
      (this.pendingMutationCounts.get(mutationId) ?? 0) + 1
    );
  }

  private decrementPendingMutation(mutationId: string): void {
    const nextCount = (this.pendingMutationCounts.get(mutationId) ?? 1) - 1;
    if (nextCount > 0) this.pendingMutationCounts.set(mutationId, nextCount);
    else this.pendingMutationCounts.delete(mutationId);
  }

  private markDataChangedDuringLoad(): void {
    this.loadGeneration++;
    if (this.loadPromise) this.refreshRequestedDuringLoad = true;
  }

  private publish(
    patch: Partial<Omit<AgentHostQuickPromptSnapshot, "revision">>
  ): void {
    if (this.disposed) return;
    this.snapshot = Object.freeze({
      ...this.snapshot,
      ...patch,
      pendingMutationIds: Object.freeze(
        patch.pendingMutationIds
          ? [...patch.pendingMutationIds]
          : [...this.snapshot.pendingMutationIds]
      ),
      prompts: Object.freeze(
        patch.prompts ? [...patch.prompts] : [...this.snapshot.prompts]
      ),
      revision: this.snapshot.revision + 1
    });
    for (const listener of this.listeners) listener(this.snapshot);
  }
}

function toHostQuickPrompt(prompt: {
  id: string;
  title: string;
  content: string;
  version: number;
  createdAtUnixMs: number;
  updatedAtUnixMs: number;
}): AgentHostQuickPrompt {
  return {
    content: prompt.content,
    createdAtUnixMs: prompt.createdAtUnixMs,
    id: prompt.id,
    title: prompt.title,
    updatedAtUnixMs: prompt.updatedAtUnixMs,
    version: prompt.version
  };
}

function movePromptBefore(
  prompts: readonly AgentHostQuickPrompt[],
  promptId: string,
  beforePromptId: string | null
): readonly AgentHostQuickPrompt[] {
  const fromIndex = prompts.findIndex((prompt) => prompt.id === promptId);
  if (fromIndex < 0 || beforePromptId === promptId) return prompts;
  const next = prompts.filter((prompt) => prompt.id !== promptId);
  const insertIndex =
    beforePromptId === null
      ? next.length
      : next.findIndex((prompt) => prompt.id === beforePromptId);
  if (insertIndex < 0) return prompts;
  next.splice(insertIndex, 0, prompts[fromIndex]!);
  return next;
}

function promptSnapshotsEqual(
  left: readonly AgentHostQuickPrompt[],
  right: readonly AgentHostQuickPrompt[]
): boolean {
  return (
    left.length === right.length &&
    left.every(
      (prompt, index) =>
        prompt.id === right[index]?.id &&
        prompt.version === right[index]?.version
    )
  );
}

function quickPromptEventKey(
  promptId: string,
  changeKind: "created" | "updated" | "deleted",
  version: number
): string {
  return `${changeKind}:${promptId}:${version}`;
}
