import type {
  TuttidClient,
  TuttidEventStreamClient
} from "@tutti-os/client-tuttid-ts";
import type { NotificationService } from "@tutti-os/ui-notifications";
import type {
  WorkspaceUserProject,
  WorkspaceUserProjectDefaultSelection,
  WorkspaceUserProjectPinInput,
  WorkspaceUserProjectPathCheck,
  WorkspaceUserProjectSelectionPreparation,
  WorkspaceUserProjectSelectionPreparationInput,
  WorkspaceUserProjectServiceSnapshot,
  WorkspaceUserProjectValtioStore
} from "@tutti-os/workspace-user-project/contracts";
import {
  pinWorkspaceUserProjectOptimistically,
  upsertWorkspaceUserProject
} from "@tutti-os/workspace-user-project/core";
import { createWorkspaceUserProjectI18nRuntime } from "@tutti-os/workspace-user-project/i18n";
import type { DesktopHostFilesApi, DesktopPlatformApi } from "@preload/types";
import { proxy, snapshot, subscribe } from "valtio/vanilla";
import type { IWorkspaceUserProjectService } from "../workspaceUserProjectService.interface.ts";
import { getAppI18nRuntime } from "../../../../i18n/appRuntime.ts";
import { getActiveLocale } from "../../../../i18n/runtime.ts";

export interface DesktopWorkspaceUserProjectServiceDependencies {
  hostFilesApi: Pick<
    DesktopHostFilesApi,
    "createUserDocumentsProjectDirectory" | "selectDirectory"
  >;
  tuttidClient: Pick<
    TuttidClient,
    | "checkUserProjectPath"
    | "deleteUserProject"
    | "listUserProjects"
    | "moveUserProject"
    | "pinUserProject"
    | "useUserProject"
  >;
  eventStreamClient?: Pick<TuttidEventStreamClient, "connect" | "subscribe">;
  logDiagnostic?: (payload: unknown) => void;
  notifications?: NotificationService;
  platformApi: Pick<DesktopPlatformApi, "homeDirectory" | "os">;
  now?: () => number;
  workspaceId: string;
}

interface DesktopWorkspaceUserProjectWorkspaceState {
  defaultSelection: WorkspaceUserProjectDefaultSelection | null;
  explicitProjectPaths: Set<string>;
  noProjectPaths: Set<string>;
  removedProjectPaths: Set<string>;
}

const workspaceUserProjectStateByWorkspaceId = new Map<
  string,
  DesktopWorkspaceUserProjectWorkspaceState
>();

export class DesktopWorkspaceUserProjectService implements IWorkspaceUserProjectService {
  readonly _serviceBrand = undefined;
  readonly store = proxy<WorkspaceUserProjectServiceSnapshot>({
    error: null,
    initialized: false,
    isLoading: false,
    isMutationPending: false,
    projects: [],
    revision: 0
  }) as WorkspaceUserProjectValtioStore;

  private readonly dependencies: DesktopWorkspaceUserProjectServiceDependencies;
  private readonly workspaceState: DesktopWorkspaceUserProjectWorkspaceState;
  private loadSequence = 0;
  private inflightLoad: Promise<void> | null = null;
  private refreshQueued = false;
  private inflightOrderingMutation: Promise<void> | null = null;
  private pendingProjectsEvent: WorkspaceUserProject[] | null = null;

  constructor(dependencies: DesktopWorkspaceUserProjectServiceDependencies) {
    this.dependencies = dependencies;
    this.workspaceState = workspaceUserProjectState(dependencies.workspaceId);
    if (dependencies.eventStreamClient) {
      dependencies.eventStreamClient.subscribe(
        "user.project.updated",
        (event) => this.acceptProjectsEvent(event.payload.projects)
      );
      void dependencies.eventStreamClient.connect().catch((error) => {
        this.logDiagnostic("user_project_event_stream_connect_failed", error);
      });
    }
  }

  async checkProjectPath(path: string): Promise<WorkspaceUserProjectPathCheck> {
    return this.dependencies.tuttidClient.checkUserProjectPath({ path });
  }

  async createProject(name: string): Promise<WorkspaceUserProject> {
    this.beginMutation();
    try {
      const directory =
        await this.dependencies.hostFilesApi.createUserDocumentsProjectDirectory(
          {
            name
          }
        );
      return await this.registerProjectPathUnlocked(directory.path);
    } finally {
      this.finishMutation();
    }
  }

  async ensureLoaded(): Promise<void> {
    if (this.store.initialized) {
      return;
    }
    return this.refresh();
  }

  getDefaultSelection(): Promise<WorkspaceUserProjectDefaultSelection | null> {
    return Promise.resolve(
      this.workspaceState.defaultSelection
        ? { path: this.workspaceState.defaultSelection.path }
        : null
    );
  }

  getRevision(): number {
    return this.store.revision;
  }

  getSnapshot(): WorkspaceUserProjectServiceSnapshot {
    return snapshot(
      this.store
    ) as unknown as WorkspaceUserProjectServiceSnapshot;
  }

  isNoProjectPath(path: string): boolean {
    const normalizedPath = path.trim();
    if (
      !normalizedPath ||
      hasProjectPath(this.store.projects, normalizedPath) ||
      this.workspaceState.explicitProjectPaths.has(normalizedPath)
    ) {
      return false;
    }
    return (
      this.workspaceState.noProjectPaths.has(normalizedPath) ||
      isGeneratedNoProjectCwd({
        homeDirectory: this.dependencies.platformApi.homeDirectory,
        path: normalizedPath,
        platform: this.dependencies.platformApi.os
      })
    );
  }

  rememberNoProjectPath(path: string | null | undefined): void {
    const normalizedPath = path?.trim() ?? "";
    if (normalizedPath) {
      this.workspaceState.noProjectPaths.add(normalizedPath);
    }
  }

  async moveProject(input: {
    projectId: string;
    beforeProjectId: string | null;
  }): Promise<void> {
    this.beginMutation();
    const optimisticProjects = moveProjectBefore(
      this.store.projects,
      input.projectId,
      input.beforeProjectId
    );
    this.supersedeLoad();
    this.store.projects = optimisticProjects;
    this.store.error = null;
    this.store.initialized = true;
    this.bumpRevision();

    this.inflightOrderingMutation = Promise.resolve();
    const move = this.confirmProjectMove(input);
    this.inflightOrderingMutation = move;
    try {
      await move;
    } finally {
      if (this.inflightOrderingMutation === move) {
        this.inflightOrderingMutation = null;
      }
      this.finishMutation();
    }
  }

  async pinProject(input: WorkspaceUserProjectPinInput): Promise<void> {
    this.beginMutation();
    const now = Math.max(1, (this.dependencies.now ?? Date.now)());
    this.supersedeLoad();
    this.store.projects = pinWorkspaceUserProjectOptimistically(
      this.store.projects,
      {
        ...input,
        pinnedAtUnixMs: now,
        updatedAtUnixMs: now
      }
    );
    this.store.error = null;
    this.store.initialized = true;
    this.bumpRevision();

    this.inflightOrderingMutation = Promise.resolve();
    const pin = this.confirmProjectPin(input);
    this.inflightOrderingMutation = pin;
    try {
      await pin;
    } finally {
      if (this.inflightOrderingMutation === pin) {
        this.inflightOrderingMutation = null;
      }
      this.finishMutation();
    }
  }

  async prepareSelection(
    input: WorkspaceUserProjectSelectionPreparationInput
  ): Promise<WorkspaceUserProjectSelectionPreparation> {
    await this.ensureLoaded();
    const projects = [...this.store.projects];
    const selectedPath = input.selectedPath?.trim() ?? "";
    const isSelectedPathMissing =
      input.projectLocked && selectedPath
        ? await this.isPathMissing(selectedPath)
        : false;

    if (
      !input.projectLocked &&
      selectedPath &&
      !hasProjectPath(projects, selectedPath)
    ) {
      await this.rememberDefaultSelection({ path: null });
      return {
        isSelectedPathMissing,
        projects,
        selection: {
          kind: "clear",
          suppressedPath: selectedPath
        }
      };
    }

    if (input.projectLocked || selectedPath) {
      return {
        isSelectedPathMissing,
        projects,
        selection: { kind: "none" }
      };
    }

    const defaultSelection = await this.getDefaultSelection();
    const defaultPath = defaultSelection?.path?.trim() ?? "";
    if (defaultPath && hasProjectPath(projects, defaultPath)) {
      return {
        isSelectedPathMissing,
        projects,
        selection: {
          kind: "select",
          path: defaultPath
        }
      };
    }
    return {
      isSelectedPathMissing,
      projects,
      selection: { kind: "none" }
    };
  }

  async refresh(): Promise<void> {
    if (this.inflightLoad) {
      this.refreshQueued = true;
      return this.inflightLoad;
    }
    const sequence = ++this.loadSequence;
    this.store.isLoading = true;
    this.store.error = null;
    this.bumpRevision();
    const load = this.loadProjects(sequence).finally(() => {
      if (this.inflightLoad === load) {
        this.inflightLoad = null;
      }
      if (this.refreshQueued) {
        this.refreshQueued = false;
        void this.refresh();
      }
    });
    this.inflightLoad = load;
    return load;
  }

  async registerProjectPath(path: string): Promise<WorkspaceUserProject> {
    this.beginMutation();
    try {
      return await this.registerProjectPathUnlocked(path);
    } finally {
      this.finishMutation();
    }
  }

  private async registerProjectPathUnlocked(
    path: string
  ): Promise<WorkspaceUserProject> {
    const project = await this.dependencies.tuttidClient.useUserProject({
      path
    });
    this.supersedeLoad();
    this.workspaceState.explicitProjectPaths.add(project.path);
    this.workspaceState.noProjectPaths.delete(project.path);
    this.workspaceState.removedProjectPaths.delete(project.path);
    this.store.projects = upsertWorkspaceUserProject(
      this.store.projects,
      project
    );
    await this.rememberDefaultSelection({ path: project.path });
    this.store.error = null;
    this.store.initialized = true;
    this.bumpRevision();
    void this.refresh();
    return project;
  }

  async removeProjectPath(path: string): Promise<void> {
    const normalizedPath = path.trim();
    if (!normalizedPath) {
      return;
    }
    this.beginMutation();
    try {
      await this.dependencies.tuttidClient.deleteUserProject({
        path: normalizedPath
      });
      const previousProjectCount = this.store.projects.length;
      this.workspaceState.explicitProjectPaths.delete(normalizedPath);
      this.workspaceState.removedProjectPaths.add(normalizedPath);
      this.store.projects = this.store.projects.filter(
        (project) => project.path !== normalizedPath
      );
      if (this.workspaceState.defaultSelection?.path === normalizedPath) {
        this.workspaceState.defaultSelection = { path: null };
      }
      this.store.error = null;
      this.store.initialized = true;
      if (this.store.projects.length !== previousProjectCount) {
        this.bumpRevision();
      }
    } finally {
      this.finishMutation();
    }
  }

  rememberDefaultSelection(input: { path: string | null }): Promise<void> {
    this.workspaceState.defaultSelection = {
      path: input.path?.trim() || null
    };
    return Promise.resolve();
  }

  async selectDirectory(): Promise<{ path: string } | null> {
    try {
      const path =
        (await this.dependencies.hostFilesApi.selectDirectory())?.trim() ?? "";
      return path ? { path } : null;
    } catch {
      this.dependencies.notifications?.error({
        title: createWorkspaceUserProjectI18nRuntime(
          getAppI18nRuntime(getActiveLocale())
        ).t("projectSelect.selectDirectoryFailed")
      });
      return null;
    }
  }

  subscribe(listener: () => void): () => void {
    return subscribe(this.store, listener);
  }

  private async loadProjects(sequence: number): Promise<void> {
    try {
      const response = await this.dependencies.tuttidClient.listUserProjects();
      if (sequence !== this.loadSequence) {
        return;
      }
      this.store.projects = response.projects.filter(
        (project) => !this.workspaceState.removedProjectPaths.has(project.path)
      );
      this.store.initialized = true;
      this.store.error = null;
    } catch (error) {
      if (sequence !== this.loadSequence) {
        return;
      }
      this.store.error = describeError(error);
    } finally {
      if (sequence === this.loadSequence) {
        this.store.isLoading = false;
        this.bumpRevision();
      }
    }
  }

  private bumpRevision(): void {
    this.store.revision += 1;
  }

  private beginMutation(): void {
    if (this.store.isMutationPending) {
      throw new Error("A user project mutation is already in progress.");
    }
    this.store.isMutationPending = true;
    this.bumpRevision();
  }

  private finishMutation(): void {
    this.store.isMutationPending = false;
    this.bumpRevision();
  }

  private supersedeLoad(): void {
    this.loadSequence += 1;
    this.refreshQueued = false;
    this.store.isLoading = false;
  }

  private acceptProjectsEvent(projects: readonly WorkspaceUserProject[]): void {
    const nextProjects = projects.map((project) => ({ ...project }));
    if (this.inflightOrderingMutation) {
      this.pendingProjectsEvent = nextProjects;
      return;
    }
    this.applyAuthoritativeProjects(nextProjects);
  }

  private applyAuthoritativeProjects(
    projects: readonly WorkspaceUserProject[]
  ): void {
    for (const project of projects) {
      this.workspaceState.removedProjectPaths.delete(project.path);
    }
    this.supersedeLoad();
    this.store.projects = projects.map((project) => ({ ...project }));
    this.store.error = null;
    this.store.initialized = true;
    this.bumpRevision();
  }

  private async confirmProjectMove(input: {
    projectId: string;
    beforeProjectId: string | null;
  }): Promise<void> {
    return this.confirmOrderingMutation(
      () =>
        this.dependencies.tuttidClient.moveUserProject({
          beforeProjectId: input.beforeProjectId,
          projectId: input.projectId
        }),
      "user_project_move_failed"
    );
  }

  private async confirmProjectPin(
    input: WorkspaceUserProjectPinInput
  ): Promise<void> {
    return this.confirmOrderingMutation(
      () => this.dependencies.tuttidClient.pinUserProject(input),
      "user_project_pin_failed"
    );
  }

  private async confirmOrderingMutation(
    request: () => Promise<{ projects: WorkspaceUserProject[] }>,
    diagnosticEvent: string
  ): Promise<void> {
    try {
      const response = await request();
      this.applyAuthoritativeProjects(response.projects);
      const pendingEvent = this.pendingProjectsEvent;
      this.pendingProjectsEvent = null;
      if (
        pendingEvent &&
        !areProjectSnapshotsEqual(pendingEvent, response.projects)
      ) {
        if (this.inflightLoad) {
          await this.inflightLoad;
        }
        await this.refresh();
        const eventDuringRefresh = this.pendingProjectsEvent;
        this.pendingProjectsEvent = null;
        if (
          eventDuringRefresh &&
          !areProjectSnapshotsEqual(eventDuringRefresh, this.store.projects)
        ) {
          this.applyAuthoritativeProjects(eventDuringRefresh);
        }
      }
    } catch (error) {
      this.pendingProjectsEvent = null;
      this.logDiagnostic(diagnosticEvent, error);
      throw error;
    }
  }

  private logDiagnostic(event: string, error: unknown): void {
    this.dependencies.logDiagnostic?.({
      error: describeError(error),
      event,
      workspaceId: this.dependencies.workspaceId
    });
  }

  private async isPathMissing(path: string): Promise<boolean> {
    try {
      const result = await this.checkProjectPath(path);
      return !result.exists || !result.isDirectory;
    } catch {
      return false;
    }
  }
}

function moveProjectBefore(
  projects: readonly WorkspaceUserProject[],
  projectId: string,
  beforeProjectId: string | null
): WorkspaceUserProject[] {
  const fromIndex = projects.findIndex((project) => project.id === projectId);
  if (fromIndex < 0) {
    return [...projects];
  }
  if (beforeProjectId === projectId) {
    return [...projects];
  }
  const next = [...projects];
  const [moving] = next.splice(fromIndex, 1);
  if (!moving) {
    return [...projects];
  }
  const beforeIndex =
    beforeProjectId === null
      ? next.length
      : next.findIndex((project) => project.id === beforeProjectId);
  if (beforeIndex < 0) {
    return [...projects];
  }
  next.splice(beforeIndex, 0, moving);
  return next;
}

function areProjectSnapshotsEqual(
  left: readonly WorkspaceUserProject[],
  right: readonly WorkspaceUserProject[]
): boolean {
  return (
    left.length === right.length &&
    left.every((project, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        project.id === candidate.id &&
        project.path === candidate.path &&
        project.label === candidate.label &&
        project.pinnedAtUnixMs === candidate.pinnedAtUnixMs &&
        project.sectionKey === candidate.sectionKey &&
        project.createdAtUnixMs === candidate.createdAtUnixMs &&
        project.updatedAtUnixMs === candidate.updatedAtUnixMs &&
        project.lastUsedAtUnixMs === candidate.lastUsedAtUnixMs
      );
    })
  );
}

function hasProjectPath(
  projects: readonly WorkspaceUserProject[],
  path: string
): boolean {
  return projects.some((project) => project.path === path);
}

function workspaceUserProjectState(
  workspaceId: string
): DesktopWorkspaceUserProjectWorkspaceState {
  const key = workspaceId.trim() || "__default__";
  let state = workspaceUserProjectStateByWorkspaceId.get(key);
  if (!state) {
    state = {
      defaultSelection: null,
      explicitProjectPaths: new Set(),
      noProjectPaths: new Set(),
      removedProjectPaths: new Set()
    };
    workspaceUserProjectStateByWorkspaceId.set(key, state);
  }
  return state;
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function isGeneratedNoProjectCwd(input: {
  homeDirectory: string;
  path: string;
  platform: NodeJS.Platform;
}): boolean {
  const homeSegments = localPathSegments(input.homeDirectory);
  if (homeSegments.length === 0) {
    return false;
  }
  const segments = localPathSegments(input.path);
  const leaf = segments.at(-1) ?? "";
  if (!isGeneratedNoProjectSessionDirectoryName(leaf)) {
    return false;
  }
  const expectedRootSegments = [...homeSegments, "Documents", "tutti"];
  const candidateRootSegments = segments.slice(0, -1);
  if (expectedRootSegments.length !== candidateRootSegments.length) {
    return false;
  }
  return expectedRootSegments.every((segment, index) =>
    input.platform === "win32"
      ? segment.toLowerCase() === candidateRootSegments[index]?.toLowerCase()
      : segment === candidateRootSegments[index]
  );
}

function localPathSegments(path: string): string[] {
  return path
    .trim()
    .split(/[\\/]+/u)
    .filter(Boolean);
}

function isGeneratedNoProjectSessionDirectoryName(name: string): boolean {
  return /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
    name
  );
}
