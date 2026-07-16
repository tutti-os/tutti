import {
  selectSessionMutations,
  type AgentSessionEngineState
} from "@tutti-os/agent-activity-core";
import type { AgentGUIConversationSummary } from "../model/agentGuiConversationModel";
import { conversationSummariesRenderEqual } from "../model/agentGuiConversationRail";
import { createConversationRailEngineProjection } from "./agentGuiConversationRailEngineProjection";

export class ConversationRailProjectionTransaction {
  private readonly inFlightMutationIds = new Set<string>();
  private readonly observedMutationStatuses = new Map<string, string>();
  private readonly project = createConversationRailEngineProjection();
  private searchHasFailed = false;
  private searchPending = false;
  private targetedHasFailed = false;
  private targetedPending = false;
  private open = false;
  private conversations: AgentGUIConversationSummary[];

  constructor(initialState: AgentSessionEngineState) {
    this.conversations = this.project(initialState);
    for (const mutation of selectSessionMutations(initialState)) {
      this.observedMutationStatuses.set(mutation.mutationId, mutation.status);
    }
  }

  get committedConversations(): AgentGUIConversationSummary[] {
    return this.conversations;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get hasSearchWork(): boolean {
    return this.searchPending;
  }

  get hasTargetedWork(): boolean {
    return this.targetedPending;
  }

  begin(): boolean {
    if (this.open) return false;
    this.open = true;
    return true;
  }

  observeMutations(state: AgentSessionEngineState): boolean {
    let started = false;
    const mutations = selectSessionMutations(state);
    const currentIds = new Set(
      mutations.map((mutation) => mutation.mutationId)
    );
    for (const mutationId of this.observedMutationStatuses.keys()) {
      if (
        !currentIds.has(mutationId) &&
        !this.inFlightMutationIds.has(mutationId)
      ) {
        this.observedMutationStatuses.delete(mutationId);
      }
    }
    for (const mutation of mutations) {
      const previous = this.observedMutationStatuses.get(mutation.mutationId);
      this.observedMutationStatuses.set(mutation.mutationId, mutation.status);
      if (mutation.status === "inFlight" && previous !== "inFlight") {
        this.inFlightMutationIds.add(mutation.mutationId);
        started = true;
      } else if (previous === "inFlight" && mutation.status !== "inFlight") {
        this.inFlightMutationIds.delete(mutation.mutationId);
      }
    }
    return started && this.begin();
  }

  resyncMutations(state: AgentSessionEngineState): boolean {
    const mutations = selectSessionMutations(state);
    this.observedMutationStatuses.clear();
    this.inFlightMutationIds.clear();
    for (const mutation of mutations) {
      this.observedMutationStatuses.set(mutation.mutationId, mutation.status);
      if (mutation.status === "inFlight") {
        this.inFlightMutationIds.add(mutation.mutationId);
      }
    }
    return this.inFlightMutationIds.size > 0 && this.begin();
  }

  targetedStarted(): void {
    this.targetedPending = true;
  }

  targetedResolved(): void {
    this.targetedPending = false;
    this.targetedHasFailed = false;
  }

  targetedFailed(): void {
    this.targetedPending = false;
    this.targetedHasFailed = true;
  }

  resetTargetedFailure(): void {
    this.targetedPending = false;
    this.targetedHasFailed = false;
  }

  searchStarted(): void {
    this.searchPending = true;
  }

  searchResolved(): void {
    this.searchPending = false;
    this.searchHasFailed = false;
  }

  searchFailed(): void {
    this.searchPending = false;
    this.searchHasFailed = true;
  }

  clearSearchPending(): void {
    this.searchPending = false;
  }

  commit(state: AgentSessionEngineState): "blocked" | "changed" | "unchanged" {
    if (
      this.inFlightMutationIds.size > 0 ||
      this.targetedPending ||
      this.searchPending ||
      this.targetedHasFailed ||
      this.searchHasFailed
    ) {
      return "blocked";
    }
    const next = this.project(state);
    const changed =
      this.open ||
      this.conversations.length !== next.length ||
      this.conversations.some(
        (conversation, index) =>
          !conversationSummariesRenderEqual(conversation, next[index]!)
      );
    if (changed) this.conversations = next;
    this.open = false;
    return changed ? "changed" : "unchanged";
  }
}
