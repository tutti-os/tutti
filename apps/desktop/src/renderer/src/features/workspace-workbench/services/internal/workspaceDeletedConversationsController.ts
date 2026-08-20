import type { NotificationService } from "@tutti-os/ui-notifications";
import { createTranslator } from "../../../../../../shared/i18n/index.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";
import type { IWorkspaceDeletedConversationsController } from "../workspaceSettingsService.interface.ts";
import type {
  WorkspaceDeletedConversation,
  WorkspaceDeletedConversationProjectFilter,
  WorkspaceDeletedConversationProjectOption,
  WorkspaceDeletedConversationsMutableState,
  WorkspaceSettingsStoreState
} from "../workspaceSettingsTypes.ts";
import type { DesktopWorkspaceSettingsClient } from "./adapters/desktopWorkspaceSettingsClient.ts";
import { createWorkspaceDeletedConversationsState } from "./workspaceSettingsStore.ts";

const deletedConversationPageSize = 40;
const deletedConversationSearchDelayMs = 250;

export interface WorkspaceDeletedConversationsControllerDependencies {
  client: Pick<
    DesktopWorkspaceSettingsClient,
    | "listWorkspaceDeletedAgentSessions"
    | "purgeWorkspaceDeletedAgentSession"
    | "purgeWorkspaceDeletedAgentSessions"
    | "restoreWorkspaceDeletedAgentSession"
  >;
  notifications: NotificationService;
  store: WorkspaceSettingsStoreState;
}

export class WorkspaceDeletedConversationsController implements IWorkspaceDeletedConversationsController {
  private readonly dependencies: WorkspaceDeletedConversationsControllerDependencies;
  private loadSequence = 0;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    dependencies: WorkspaceDeletedConversationsControllerDependencies
  ) {
    this.dependencies = dependencies;
  }

  private get store() {
    return this.dependencies.store;
  }

  private get state() {
    return this.store.deletedConversations;
  }

  reset(): void {
    this.loadSequence += 1;
    this.clearSearchTimer();
    this.store.deletedConversations =
      createWorkspaceDeletedConversationsState();
  }

  setSearch(search: string): void {
    if (this.state.search === search) {
      return;
    }
    this.state.search = search;
    this.clearSearchTimer();
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.refresh();
    }, deletedConversationSearchDelayMs);
  }

  selectProject(filter: WorkspaceDeletedConversationProjectFilter): void {
    if (projectFiltersEqual(this.state.projectFilter, filter)) {
      return;
    }
    this.state.projectFilter = filter;
    this.clearSearchTimer();
    void this.refresh();
  }

  clearFilters(): void {
    if (this.state.search === "" && this.state.projectFilter.kind === "all") {
      return;
    }
    this.state.search = "";
    this.state.projectFilter = { kind: "all" };
    this.clearSearchTimer();
    void this.refresh();
  }

  async refresh(): Promise<void> {
    await this.loadPage(false);
  }

  async loadMore(): Promise<void> {
    if (
      this.state.loading ||
      this.state.loadingMore ||
      !this.state.hasMore ||
      !this.state.nextCursor
    ) {
      return;
    }
    await this.loadPage(true);
  }

  async restore(agentSessionID: string): Promise<boolean> {
    return await this.runSessionOperation(
      agentSessionID,
      "restoring",
      async (workspaceID, state, operationLoadSequence) => {
        await this.dependencies.client.restoreWorkspaceDeletedAgentSession(
          workspaceID,
          agentSessionID
        );
        if (
          !(await this.reconcileSuccessfulSessionOperation(
            workspaceID,
            state,
            agentSessionID,
            operationLoadSequence
          ))
        ) {
          return true;
        }
        this.dependencies.notifications.success({
          title: translate(
            "workspace.settings.deletedConversations.restoreCompleted"
          )
        });
        return true;
      }
    );
  }

  async purgeOne(agentSessionID: string): Promise<boolean> {
    return await this.runSessionOperation(
      agentSessionID,
      "deleting",
      async (workspaceID, state, operationLoadSequence) => {
        await this.dependencies.client.purgeWorkspaceDeletedAgentSession(
          workspaceID,
          agentSessionID
        );
        if (
          !(await this.reconcileSuccessfulSessionOperation(
            workspaceID,
            state,
            agentSessionID,
            operationLoadSequence
          ))
        ) {
          return true;
        }
        this.dependencies.notifications.success({
          title: translate(
            "workspace.settings.deletedConversations.deleteCompleted"
          )
        });
        return true;
      }
    );
  }

  async purgeAll(): Promise<boolean> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    if (!workspaceID || state.purgingAll) {
      return false;
    }
    const deletedConversationCount = state.workspaceTotalCount;
    this.clearSearchTimer();
    this.invalidateLoads(state);
    state.purgingAll = true;
    try {
      await this.dependencies.client.purgeWorkspaceDeletedAgentSessions(
        workspaceID
      );
      if (!this.isCurrentState(workspaceID, state)) {
        return true;
      }
      state.sessions = [];
      state.projectOptions = [];
      state.hasMore = false;
      state.loadFailed = false;
      state.loadMoreFailed = false;
      state.loading = false;
      state.loadingMore = false;
      state.nextCursor = null;
      state.projectFilter = { kind: "all" };
      state.search = "";
      state.totalCount = 0;
      state.workspaceTotalCount = 0;
      this.dependencies.notifications.success({
        title: translate(
          "workspace.settings.deletedConversations.deleteAllCompleted",
          { count: String(deletedConversationCount) }
        )
      });
      return true;
    } catch {
      if (this.isCurrentState(workspaceID, state)) {
        this.dependencies.notifications.error({
          title: translate(
            "workspace.settings.deletedConversations.permanentDeleteFailed"
          )
        });
        // The destructive request fenced any older list response and canceled
        // a pending search debounce. Re-read the current filter after failure
        // so an in-flight refresh cannot leave the panel in a false empty
        // state with no retry affordance.
        await this.refresh();
      }
      return false;
    } finally {
      state.purgingAll = false;
    }
  }

  private async loadPage(append: boolean): Promise<void> {
    const workspaceID = this.store.workspaceID;
    if (!workspaceID) {
      return;
    }
    const state = this.state;
    const sequence = ++this.loadSequence;
    if (append) {
      state.loadingMore = true;
      state.loadMoreFailed = false;
    } else {
      state.loading = true;
      state.loadingMore = false;
      state.loadFailed = false;
      state.loadMoreFailed = false;
      state.sessions = [];
      state.hasMore = false;
      state.nextCursor = null;
      state.totalCount = 0;
    }
    const filter = state.projectFilter;
    const search = state.search.trim();
    try {
      const page =
        await this.dependencies.client.listWorkspaceDeletedAgentSessions(
          workspaceID,
          {
            cursor: append ? state.nextCursor : null,
            limit: deletedConversationPageSize,
            railSectionKey:
              filter.kind === "project"
                ? filter.railSectionKey
                : filter.kind === "unscoped"
                  ? "conversations"
                  : null,
            search: search || null
          }
        );
      if (
        sequence !== this.loadSequence ||
        workspaceID !== this.store.workspaceID
      ) {
        return;
      }
      state.sessions = sortAndDedupeSessions(
        append ? [...state.sessions, ...page.sessions] : page.sessions
      );
      state.nextCursor = page.nextCursor ?? null;
      state.hasMore = page.hasMore;
      state.totalCount = page.totalCount;
      if (page.workspaceTotalCount !== undefined) {
        state.workspaceTotalCount = page.workspaceTotalCount;
      } else if (filter.kind === "all" && search === "") {
        state.workspaceTotalCount = page.totalCount;
      }
      state.projectOptions = mergeProjectOptions(
        page.projectOptions === undefined && append ? state.projectOptions : [],
        page.projectOptions ?? page.sessions
      );
    } catch {
      if (
        sequence === this.loadSequence &&
        workspaceID === this.store.workspaceID
      ) {
        if (append) {
          state.loadMoreFailed = true;
        } else {
          state.loadFailed = true;
        }
      }
    } finally {
      if (
        sequence === this.loadSequence &&
        workspaceID === this.store.workspaceID
      ) {
        state.loading = false;
        state.loadingMore = false;
      }
    }
  }

  private async runSessionOperation(
    agentSessionID: string,
    operation: "deleting" | "restoring",
    run: (
      workspaceID: string,
      state: WorkspaceDeletedConversationsMutableState,
      operationLoadSequence: number
    ) => Promise<boolean>
  ): Promise<boolean> {
    const workspaceID = this.store.workspaceID;
    const state = this.state;
    if (!workspaceID || state.operationBySessionID[agentSessionID]) {
      return false;
    }
    const operationLoadSequence = this.loadSequence;
    state.operationBySessionID = {
      ...state.operationBySessionID,
      [agentSessionID]: operation
    };
    try {
      return await run(workspaceID, state, operationLoadSequence);
    } catch {
      if (this.isCurrentState(workspaceID, state)) {
        this.dependencies.notifications.error({
          title: translate(
            operation === "restoring"
              ? "workspace.settings.deletedConversations.restoreFailed"
              : "workspace.settings.deletedConversations.permanentDeleteFailed"
          )
        });
      }
      return false;
    } finally {
      const operations = { ...state.operationBySessionID };
      delete operations[agentSessionID];
      state.operationBySessionID = operations;
    }
  }

  private async reconcileSuccessfulSessionOperation(
    workspaceID: string,
    state: WorkspaceDeletedConversationsMutableState,
    agentSessionID: string,
    operationLoadSequence: number
  ): Promise<boolean> {
    if (!this.isCurrentState(workspaceID, state)) {
      return false;
    }
    if (this.loadSequence !== operationLoadSequence) {
      // A search/project refresh started while the mutation was in flight. It
      // may have read the pre-mutation row, so replace it with a request that
      // starts after the successful server commit instead of invalidating the
      // user's newer filter load and leaving its cleared state behind.
      await this.refresh();
      return this.isCurrentState(workspaceID, state);
    }
    // Loads already in flight when the operation began can only contain stale
    // data. Fence those responses before applying the local committed result.
    this.invalidateLoads(state);
    this.removeSession(state, agentSessionID);
    return true;
  }

  private removeSession(
    state: WorkspaceDeletedConversationsMutableState,
    agentSessionID: string
  ): void {
    const previousLength = state.sessions.length;
    state.sessions = state.sessions.filter(
      (session) => session.agentSessionId !== agentSessionID
    );
    if (state.sessions.length === previousLength) {
      return;
    }
    state.totalCount = Math.max(0, state.totalCount - 1);
    state.workspaceTotalCount = Math.max(0, state.workspaceTotalCount - 1);
  }

  private clearSearchTimer(): void {
    if (this.searchTimer !== null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
  }

  private invalidateLoads(
    state: WorkspaceDeletedConversationsMutableState
  ): void {
    this.loadSequence += 1;
    state.loading = false;
    state.loadingMore = false;
  }

  private isCurrentState(
    workspaceID: string,
    state: WorkspaceDeletedConversationsMutableState
  ): boolean {
    return this.store.workspaceID === workspaceID && this.state === state;
  }
}

function sortAndDedupeSessions(
  sessions: readonly WorkspaceDeletedConversation[]
): WorkspaceDeletedConversation[] {
  return [
    ...new Map(
      sessions.map((session) => [session.agentSessionId, session])
    ).values()
  ].sort(
    (left, right) =>
      right.updatedAtUnixMs - left.updatedAtUnixMs ||
      compareOrdinal(left.agentSessionId, right.agentSessionId)
  );
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function mergeProjectOptions(
  existing: readonly WorkspaceDeletedConversationProjectOption[],
  incoming:
    | readonly WorkspaceDeletedConversationProjectOption[]
    | readonly WorkspaceDeletedConversation[]
): WorkspaceDeletedConversationProjectOption[] {
  const bySectionKey = new Map(
    existing.map((option) => [option.railSectionKey, option])
  );
  for (const item of incoming) {
    if (!item.railSectionKey || item.railSectionKey === "conversations") {
      continue;
    }
    bySectionKey.set(item.railSectionKey, {
      projectAvailable: item.projectAvailable,
      projectLabel:
        item.projectLabel?.trim() ||
        (item.projectPath ? projectBasename(item.projectPath) : null) ||
        item.railSectionKey,
      projectPath: item.projectPath,
      railSectionKey: item.railSectionKey
    });
  }
  return [...bySectionKey.values()].sort(
    (left, right) =>
      left.projectLabel.localeCompare(right.projectLabel) ||
      left.railSectionKey.localeCompare(right.railSectionKey)
  );
}

function projectBasename(projectPath: string): string {
  return (
    projectPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() || projectPath
  );
}

function projectFiltersEqual(
  left: WorkspaceDeletedConversationProjectFilter,
  right: WorkspaceDeletedConversationProjectFilter
): boolean {
  return (
    left.kind === right.kind &&
    (left.kind !== "project" ||
      (right.kind === "project" &&
        left.railSectionKey === right.railSectionKey))
  );
}

function translate(
  key:
    | "workspace.settings.deletedConversations.deleteAllCompleted"
    | "workspace.settings.deletedConversations.deleteCompleted"
    | "workspace.settings.deletedConversations.permanentDeleteFailed"
    | "workspace.settings.deletedConversations.restoreCompleted"
    | "workspace.settings.deletedConversations.restoreFailed",
  params?: Record<string, string>
): string {
  return createTranslator(getActiveLocale()).t(key, params);
}
