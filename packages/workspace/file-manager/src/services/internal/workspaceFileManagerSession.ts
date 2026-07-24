import { subscribe } from "valtio/vanilla";
import {
  normalizeWorkspaceFilePath,
  validateWorkspaceFileEntryName,
  workspaceFileDirectory
} from "../workspaceFileManagerModel.ts";
import { getWorkspaceFileManagerPersistedState } from "./workspaceFileManagerStore.ts";
import {
  findWorkspaceFileLocationById,
  isWorkspaceFileExternalLocation,
  isWorkspaceFileRecentLocation,
  resolveWorkspaceFileLocationDefaultId
} from "../workspaceFileManagerLocations.ts";
import type { WorkspaceFileManagerI18nRuntime } from "../../i18n/workspaceFileManagerI18n.ts";
import type {
  CreateWorkspaceFileManagerSessionInput,
  WorkspaceFileManagerHost,
  WorkspaceFileManagerMutationErrorMessage
} from "../workspaceFileManagerHost.interface.ts";
import type {
  WorkspaceFileManagerFileActivationRequest,
  WorkspaceFileManagerHostFallbackAction
} from "../workspaceFileManagerHostTypes.ts";
import type { WorkspaceFileManagerSession } from "../workspaceFileManagerService.interface.ts";
import type {
  WorkspaceFileEntry,
  WorkspaceFileLocation,
  WorkspaceFileLocationSection,
  WorkspaceFileOpenWithApplication,
  WorkspaceFileManagerPersistedState,
  WorkspaceFileSearchEntry,
  WorkspaceFileManagerState
} from "../workspaceFileManagerTypes.ts";
import { WorkspaceFileManagerActivationController } from "./workspaceFileManagerActivationController.ts";
import { WorkspaceFileManagerMutationController } from "./workspaceFileManagerMutationController.ts";
import { WorkspaceFileManagerNavigationController } from "./workspaceFileManagerNavigationController.ts";
import { WorkspaceFileManagerPreviewController } from "./workspaceFileManagerPreviewController.ts";
import { WorkspaceFileManagerTreeController } from "./workspaceFileManagerTreeController.ts";
import { findWorkspaceFileEntry } from "./model/entryLookup.ts";
import {
  resolveWorkspaceFileOpenWithCacheKey,
  WorkspaceFileOpenWithApplicationsCache
} from "./model/openWithApplicationsCache.ts";

export interface WorkspaceFileManagerSessionInput {
  copy: WorkspaceFileManagerI18nRuntime;
  host: WorkspaceFileManagerHost;
  onMutationErrorMessage?: (
    message: WorkspaceFileManagerMutationErrorMessage
  ) => boolean | void;
  persistence?: CreateWorkspaceFileManagerSessionInput["persistence"];
  resolveFileDefaultOpener?: CreateWorkspaceFileManagerSessionInput["resolveFileDefaultOpener"];
  store: WorkspaceFileManagerState;
}

export class DefaultWorkspaceFileManagerSession implements WorkspaceFileManagerSession {
  readonly store: WorkspaceFileManagerState;
  private readonly host: WorkspaceFileManagerHost;
  private hasInitialized = false;
  /**
   * True after a directory listing attempt finished without leaving the session
   * mid-flight. Empty folders set this too — "no entries" is not "not loaded".
   */
  private hasSettledDirectoryListing = false;
  private initializePromise: Promise<void> | null = null;
  private isActive = false;
  private isDisposed = false;
  private lastObservedEntries: WorkspaceFileManagerState["entries"];
  private lastObservedPersistedState: string;
  private lastObservedSelectedPath: WorkspaceFileManagerState["selectedPath"];
  private lastRevealRequestID: string | null = null;
  private readonly onMutationErrorMessage?: (
    message: WorkspaceFileManagerMutationErrorMessage
  ) => boolean | void;
  private searchRequestSeq = 0;
  private readonly activationController: WorkspaceFileManagerActivationController;
  private copy: WorkspaceFileManagerI18nRuntime;
  private readonly mutationController: WorkspaceFileManagerMutationController;
  private readonly navigationController: WorkspaceFileManagerNavigationController;
  private readonly previewController: WorkspaceFileManagerPreviewController;
  private readonly treeController: WorkspaceFileManagerTreeController;
  private readonly persistence?: CreateWorkspaceFileManagerSessionInput["persistence"];
  private unsubscribeStore: (() => void) | null = null;
  private readonly openWithApplicationsCache =
    new WorkspaceFileOpenWithApplicationsCache();

  constructor(input: WorkspaceFileManagerSessionInput) {
    this.copy = input.copy;
    this.host = input.host;
    this.onMutationErrorMessage = input.onMutationErrorMessage;
    this.persistence = input.persistence;
    this.store = input.store;
    this.navigationController = new WorkspaceFileManagerNavigationController({
      host: input.host,
      resolveErrorMessage: (error) => this.resolveErrorMessage(error),
      store: this.store
    });
    this.treeController = new WorkspaceFileManagerTreeController({
      host: input.host,
      resolveErrorMessage: (error) => this.resolveErrorMessage(error),
      store: this.store
    });
    this.activationController = new WorkspaceFileManagerActivationController({
      copy: () => this.copy,
      host: input.host,
      loadDirectory: (path) => this.loadDirectory(path),
      resolveErrorMessage: (error, overrides) =>
        this.resolveErrorMessage(error, overrides),
      resolveFileDefaultOpener: input.resolveFileDefaultOpener,
      store: this.store
    });
    this.mutationController = new WorkspaceFileManagerMutationController({
      host: input.host,
      onErrorMessage: (message) => this.onMutationErrorMessage?.(message),
      refresh: () => this.refresh(),
      resolveErrorMessage: (error) => this.resolveErrorMessage(error),
      store: this.store
    });
    this.previewController = new WorkspaceFileManagerPreviewController({
      copy: () => this.copy,
      host: input.host,
      resolveErrorMessage: (error, overrides) =>
        this.resolveErrorMessage(error, overrides),
      store: this.store
    });
    this.lastObservedEntries = this.store.entries;
    this.lastObservedPersistedState = serializePersistedState(
      this.getPersistedState()
    );
    this.lastObservedSelectedPath = this.store.selectedPath;
  }

  async activateFile(request: WorkspaceFileManagerFileActivationRequest) {
    return this.activationController.activateFile(request);
  }

  async applyRevealIntent(
    intent: {
      mode?: "select" | "open";
      path: string;
      requestID: string;
    } | null
  ): Promise<void> {
    if (!intent?.path || !intent.requestID) {
      return;
    }
    if (intent.requestID === this.lastRevealRequestID) {
      return;
    }
    this.lastRevealRequestID = intent.requestID;
    if (intent.mode === "open") {
      await this.loadDirectory(intent.path);
      return;
    }
    await this.revealPath(intent.path);
  }

  closeContextMenu(): void {
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
  }

  closeCreateDialog(): void {
    if (this.store.busyAction === "create") {
      return;
    }
    this.store.createDialog = null;
  }

  closeDeleteDialog(): void {
    if (this.store.busyAction === "delete") {
      return;
    }
    this.store.deleteDialog = null;
  }

  cancelInlineRename(): void {
    if (this.store.busyAction === "rename") {
      return;
    }
    this.store.inlineRenameEntryPath = null;
    this.store.inlineRenameValidation = null;
  }

  closeTransientUi(): void {
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    if (this.store.busyAction !== null) {
      return;
    }
    this.store.createDialog = null;
    this.store.deleteDialog = null;
    this.store.inlineRenameEntryPath = null;
    this.store.inlineRenameValidation = null;
    this.store.unsupportedDialog = null;
  }

  closeUnsupportedDialog(): void {
    if (this.store.busyAction === "view") {
      return;
    }
    this.store.unsupportedDialog = null;
  }

  async confirmCreateDialog(): Promise<void> {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    const createDialog = this.store.createDialog;
    if (!createDialog) {
      return;
    }
    const validation = validateWorkspaceFileEntryName(createDialog.name);
    if (validation) {
      this.store.createDialog = {
        ...createDialog,
        errorMessage:
          validation === "required"
            ? this.copy.t("createNameRequired")
            : this.copy.t("createNameInvalid")
      };
      return;
    }

    const path =
      `${this.store.currentDirectoryPath}/${createDialog.name.trim()}`.replaceAll(
        /\/+/g,
        "/"
      );
    this.store.busyAction = "create";
    try {
      if (createDialog.kind === "directory") {
        await this.createDirectory(path);
      } else {
        await this.createFile(path);
      }
      this.store.createDialog = null;
    } finally {
      this.store.busyAction = null;
    }
  }

  async confirmDeleteDialog(): Promise<void> {
    const deleteDialog = this.store.deleteDialog;
    if (!deleteDialog) {
      return;
    }
    this.store.busyAction = "delete";
    try {
      this.store.selectedPath = deleteDialog.entryPath;
      await this.deleteSelected();
      this.store.deleteDialog = null;
    } finally {
      this.store.busyAction = null;
    }
  }

  async confirmInlineRename(newName: string): Promise<boolean> {
    const inlineRenameEntryPath = this.store.inlineRenameEntryPath;
    if (!inlineRenameEntryPath) {
      return true;
    }
    const entry = findWorkspaceFileEntry(this.store, inlineRenameEntryPath);
    if (!entry) {
      this.store.inlineRenameEntryPath = null;
      this.store.inlineRenameValidation = null;
      return true;
    }

    const trimmedName = newName.trim();
    if (trimmedName === entry.name) {
      this.store.inlineRenameEntryPath = null;
      this.store.inlineRenameValidation = null;
      return true;
    }

    const validation = validateWorkspaceFileEntryName(trimmedName);
    if (validation) {
      this.store.inlineRenameValidation = validation;
      return false;
    }

    this.store.inlineRenameValidation = null;
    this.store.busyAction = "rename";
    try {
      await this.mutationController.renameEntry(entry, trimmedName);
      this.store.inlineRenameEntryPath = null;
      return true;
    } finally {
      this.store.busyAction = null;
    }
  }

  async createDirectory(path: string): Promise<void> {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    await this.mutationController.createDirectory(path);
  }

  async createFile(path: string): Promise<void> {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    await this.mutationController.createFile(path);
  }

  async deleteSelected(): Promise<void> {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    await this.mutationController.deleteSelected();
  }

  dispose(): void {
    this.isDisposed = true;
    this.hasInitialized = false;
    this.hasSettledDirectoryListing = false;
    this.initializePromise = null;
    this.isActive = false;
    this.searchRequestSeq += 1;
    this.store.isSearching = false;
    this.unsubscribeStore?.();
    this.unsubscribeStore = null;
    this.previewController.dispose();
  }

  async goBack(): Promise<void> {
    await this.navigationController.goBack();
    this.syncSelectedDirectoryLocation();
  }

  async goForward(): Promise<void> {
    await this.navigationController.goForward();
    this.syncSelectedDirectoryLocation();
  }

  getPersistedState(): WorkspaceFileManagerPersistedState {
    return getWorkspaceFileManagerPersistedState(this.store);
  }

  async handleActivationFallbackAction(
    action: WorkspaceFileManagerHostFallbackAction
  ): Promise<void> {
    await this.activationController.handleFallbackAction(action);
  }

  async initialize(): Promise<void> {
    if (this.hasInitialized) {
      return;
    }
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }
    this.isDisposed = false;
    this.initializePromise = (async () => {
      this.observeStore();
      if (!this.hasLoadedDirectoryState()) {
        // loadDirectory owns isLoading true→false. Do not latch isLoading here:
        // a host that primes loading and then aborts initialize would stick.
        await this.loadSelectedLocationOrDirectory();
      }
      await this.previewController.syncPreviewState();
      this.hasInitialized = true;
    })();
    try {
      await this.initializePromise;
    } finally {
      this.initializePromise = null;
      // If init aborted/failed before a listing settled, never leave the UI
      // spinning on a stale loading latch.
      if (!this.hasSettledDirectoryListing && this.store.isLoading) {
        this.store.isLoading = false;
      }
    }
  }

  async loadDirectory(path = this.store.currentDirectoryPath): Promise<void> {
    this.clearSearchState();
    await this.navigationController.loadDirectory(path);
    if (!this.store.isLoading) {
      this.hasSettledDirectoryListing = true;
    }
    this.syncSelectedDirectoryLocation();
  }

  openContextMenu(input: {
    entryPath: string | null;
    x: number;
    y: number;
  }): void {
    this.store.contextMenuEntryPath = input.entryPath;
    this.store.contextMenu = input;
  }

  openCreateDirectoryDialog(): void {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    this.store.createDialog = {
      errorMessage: null,
      kind: "directory",
      name: ""
    };
  }

  openCreateFileDialog(): void {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    this.store.createDialog = {
      errorMessage: null,
      kind: "file",
      name: ""
    };
  }

  openDeleteDialog(entry: WorkspaceFileEntry): void {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    this.store.deleteDialog = {
      entryPath: entry.path
    };
  }

  startInlineRename(entry: WorkspaceFileEntry): void {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    this.store.inlineRenameEntryPath = entry.path;
    this.store.inlineRenameValidation = null;
    this.store.selectedPath = entry.path;
  }

  async toggleDirectoryExpanded(entry: WorkspaceFileEntry): Promise<void> {
    await this.treeController.toggleDirectoryExpanded(entry);
  }

  async copyToClipboard(entry: WorkspaceFileEntry): Promise<void> {
    if (this.isExternalLocationSelected()) {
      return;
    }
    if (!this.host.copyEntriesToClipboard) {
      return;
    }

    await this.host.copyEntriesToClipboard({
      paths: [entry.path],
      workspaceID: this.store.workspaceID
    });
  }

  getCachedOpenWithApplications(
    entry: WorkspaceFileEntry
  ): WorkspaceFileOpenWithApplication[] | null {
    if (!this.host.listOpenWithApplications) {
      return null;
    }
    return this.openWithApplicationsCache.get(
      resolveWorkspaceFileOpenWithCacheKey(entry)
    );
  }

  async listOpenWithApplications(
    entry: WorkspaceFileEntry
  ): Promise<WorkspaceFileOpenWithApplication[]> {
    if (!this.host.listOpenWithApplications) {
      return [];
    }
    return this.openWithApplicationsCache.resolve(
      resolveWorkspaceFileOpenWithCacheKey(entry),
      () =>
        this.host.listOpenWithApplications!({
          path: entry.path,
          workspaceID: this.store.workspaceID
        })
    );
  }

  async openEntry(entry: WorkspaceFileEntry): Promise<void> {
    await this.activationController.openEntry(entry);
  }

  async openFileWithApplication(
    entry: WorkspaceFileEntry,
    applicationPath: string
  ): Promise<void> {
    if (!this.host.openFileWithApplication) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    await this.host.openFileWithApplication({
      applicationPath,
      path: entry.path,
      workspaceID: this.store.workspaceID
    });
  }

  async openFileInAppBrowser(entry: WorkspaceFileEntry): Promise<void> {
    if (!this.host.openFileInAppBrowser) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    await this.host.openFileInAppBrowser({
      path: entry.path,
      workspaceID: this.store.workspaceID
    });
  }

  async openFileInDefaultBrowser(entry: WorkspaceFileEntry): Promise<void> {
    if (!this.host.openFileInDefaultBrowser) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    await this.host.openFileInDefaultBrowser({
      path: entry.path,
      workspaceID: this.store.workspaceID
    });
  }

  async openFileInFileViewer(entry: WorkspaceFileEntry): Promise<void> {
    await this.activationController.openFileInFileViewer(entry);
  }

  async openFileInSystemDefault(entry: WorkspaceFileEntry): Promise<void> {
    if (!this.host.openFileInSystemDefault) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    await this.host.openFileInSystemDefault({
      path: entry.path,
      workspaceID: this.store.workspaceID
    });
  }

  async openFileWithOtherApplication(entry: WorkspaceFileEntry): Promise<void> {
    if (!this.host.openFileWithOtherApplication) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    await this.host.openFileWithOtherApplication({
      applicationPickerPrompt: this.copy.t("openWithOtherPickerPrompt"),
      path: entry.path,
      workspaceID: this.store.workspaceID
    });
  }

  async revealEntry(entry: WorkspaceFileEntry): Promise<void> {
    if (!this.host.revealEntry) {
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    await this.host.revealEntry({
      path: entry.path,
      workspaceID: this.store.workspaceID
    });
  }

  async moveEntry(
    entry: WorkspaceFileEntry,
    targetDirectoryPath: string
  ): Promise<void> {
    if (this.isReadOnlyLocationSelected()) {
      return;
    }
    this.store.busyAction = "move";
    try {
      await this.mutationController.moveEntry(entry, targetDirectoryPath);
    } finally {
      this.store.busyAction = null;
    }
  }

  async refresh(): Promise<void> {
    const selectedLocation = this.selectedLocation();
    if (isWorkspaceFileExternalLocation(selectedLocation)) {
      return;
    }
    if (selectedLocation?.kind === "recent") {
      await this.loadRecentLocation(selectedLocation);
      return;
    }
    await this.navigationController.refresh();
  }

  async revealPath(path: string): Promise<void> {
    await this.navigationController.revealPath(path);
    this.syncSelectedDirectoryLocation();
  }

  async search(query: string): Promise<void> {
    const requestID = ++this.searchRequestSeq;
    this.store.searchQuery = query;
    this.store.searchError = null;
    const trimmedQuery = query.trim();
    if (trimmedQuery === "") {
      this.store.searchEntries = [];
      this.store.isSearching = false;
      return;
    }

    this.store.isSearching = true;
    try {
      const selectedLocation = this.selectedLocation();
      const entries = isWorkspaceFileRecentLocation(selectedLocation)
        ? await this.searchRecentEntries(trimmedQuery)
        : await this.searchDirectoryEntries(query, selectedLocation);
      if (this.isDisposed || requestID !== this.searchRequestSeq) {
        return;
      }
      this.store.searchEntries = entries;
    } catch (error) {
      if (!this.isDisposed && requestID === this.searchRequestSeq) {
        this.store.searchError = this.resolveErrorMessage(error);
      }
    } finally {
      if (!this.isDisposed && requestID === this.searchRequestSeq) {
        this.store.isSearching = false;
      }
    }
  }

  select(path: string | null): void {
    const nextSelectedPath = path
      ? normalizeWorkspaceFilePath(path, this.store.root)
      : null;
    if (this.store.selectedPath === nextSelectedPath) {
      if (
        nextSelectedPath !== null &&
        !isPreviewStateForPath(this.store.previewState, nextSelectedPath)
      ) {
        void this.previewController.syncPreviewState();
      }
      return;
    }
    this.store.selectedPath = nextSelectedPath;
  }

  async selectLocation(locationId: string): Promise<void> {
    const location = findWorkspaceFileLocationById(
      this.store.locationSections,
      locationId
    );
    if (!location) {
      return;
    }
    this.store.selectedLocationId = location.id;
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
    this.store.createDialog = null;
    this.store.deleteDialog = null;
    this.store.inlineRenameEntryPath = null;
    this.store.inlineRenameValidation = null;
    this.clearSearchState();
    if (location.kind === "external") {
      this.store.selectedPath = null;
      this.store.previewState = { status: "empty" };
      return;
    }
    if (location.kind === "recent") {
      await this.loadRecentLocation(location);
      return;
    }
    await this.loadDirectory(location.path);
  }

  setActive(active: boolean): void {
    if (this.isActive === active) {
      return;
    }
    this.isActive = active;
    if (active) {
      // Recover only when initialize finished without ever settling a listing
      // (superseded/remount race). A settled empty folder must not reload.
      if (
        this.hasInitialized &&
        !this.hasSettledDirectoryListing &&
        !this.store.isLoading
      ) {
        void this.loadSelectedLocationOrDirectory();
      }
      return;
    }
    this.store.contextMenu = null;
    this.store.contextMenuEntryPath = null;
  }

  setI18nRuntime(copy: WorkspaceFileManagerI18nRuntime): void {
    if (this.copy === copy) {
      return;
    }
    this.copy = copy;
    void this.previewController.syncPreviewState();
  }

  async setLocations(input: {
    defaultLocationId?: string | null;
    sections: WorkspaceFileLocationSection[];
  }): Promise<void> {
    const previousLocationId = this.store.selectedLocationId;
    const previousLocation = findWorkspaceFileLocationById(
      this.store.locationSections,
      previousLocationId
    );
    this.store.locationSections = input.sections;
    const nextLocationId = resolveWorkspaceFileLocationDefaultId({
      defaultLocationId: input.defaultLocationId,
      persistedLocationId: previousLocationId,
      sections: input.sections
    });
    const nextLocation = findWorkspaceFileLocationById(
      input.sections,
      nextLocationId
    );
    this.store.selectedLocationId = nextLocationId;
    if (!this.hasInitialized || !nextLocationId) {
      return;
    }
    const selectedLocationChanged =
      previousLocationId !== nextLocationId ||
      previousLocation?.kind !== nextLocation?.kind ||
      (previousLocation?.kind === "directory" &&
        nextLocation?.kind === "directory" &&
        !areWorkspaceFilePathsEqual(
          previousLocation.path,
          nextLocation.path
        )) ||
      (previousLocation?.kind === "external" &&
        nextLocation?.kind === "external" &&
        previousLocation.externalType !== nextLocation.externalType);
    if (selectedLocationChanged) {
      await this.selectLocation(nextLocationId);
    }
  }

  updateCreateDialogName(name: string): void {
    if (!this.store.createDialog) {
      return;
    }
    this.store.createDialog = {
      ...this.store.createDialog,
      errorMessage: null,
      name
    };
  }

  clearInlineRenameValidation(): void {
    this.store.inlineRenameValidation = null;
  }

  private hasLoadedDirectoryState(): boolean {
    // selectedPath alone is not a listing — persistence can restore a selection
    // before any directory.list runs. Skipping load left the panel empty/stuck.
    return (
      this.hasSettledDirectoryListing ||
      this.store.error !== null ||
      this.store.entries.length > 0
    );
  }

  private async loadSelectedLocationOrDirectory(): Promise<void> {
    const selectedLocation = this.selectedLocation();
    if (isWorkspaceFileExternalLocation(selectedLocation)) {
      this.hasSettledDirectoryListing = true;
      this.store.isLoading = false;
      return;
    }
    if (selectedLocation?.kind === "recent") {
      await this.loadRecentLocation(selectedLocation);
      return;
    }
    await this.loadDirectory(
      this.resolveInitialDirectoryPath(selectedLocation)
    );
  }

  private async loadRecentLocation(
    location: Extract<WorkspaceFileLocation, { kind: "recent" }>
  ): Promise<void> {
    this.store.isLoading = true;
    this.store.error = null;
    try {
      const listing = await this.host.listRecentEntries?.({
        workspaceID: this.store.workspaceID
      });
      this.store.root = normalizeWorkspaceFilePath(
        listing?.root ?? this.store.root
      );
      this.store.currentDirectoryPath =
        listing?.directoryPath ?? this.store.root;
      this.store.entries = listing?.entries ?? [];
      this.store.directoryExpansionByPath = {};
      this.store.expandedDirectoryPaths = {};
      this.store.navigationBackStack = [];
      this.store.navigationForwardStack = [];
      this.store.selectedLocationId = location.id;
      this.store.selectedPath = null;
    } catch (error) {
      this.store.error = this.resolveErrorMessage(error);
    } finally {
      this.store.isLoading = false;
      this.hasSettledDirectoryListing = true;
    }
  }

  private selectedLocation(): WorkspaceFileLocation | null {
    return findWorkspaceFileLocationById(
      this.store.locationSections,
      this.store.selectedLocationId
    );
  }

  private isRecentLocationSelected(): boolean {
    return isWorkspaceFileRecentLocation(this.selectedLocation());
  }

  private isExternalLocationSelected(): boolean {
    return isWorkspaceFileExternalLocation(this.selectedLocation());
  }

  private isReadOnlyLocationSelected(): boolean {
    const selectedLocation = this.selectedLocation();
    return (
      isWorkspaceFileRecentLocation(selectedLocation) ||
      isWorkspaceFileExternalLocation(selectedLocation)
    );
  }

  private resolveInitialDirectoryPath(
    selectedLocation: WorkspaceFileLocation | null
  ): string {
    if (selectedLocation?.kind !== "directory") {
      return this.store.currentDirectoryPath;
    }
    return isWorkspaceFilePathWithinDirectory(
      this.store.currentDirectoryPath,
      selectedLocation.path
    )
      ? this.store.currentDirectoryPath
      : selectedLocation.path;
  }

  private syncSelectedDirectoryLocation(): void {
    if (this.store.error) {
      return;
    }
    this.store.selectedLocationId = this.resolveDirectoryLocationIdForPath(
      this.store.currentDirectoryPath
    );
  }

  private resolveDirectoryLocationIdForPath(path: string): string | null {
    let bestLocation: {
      id: string;
      path: string;
    } | null = null;
    for (const section of this.store.locationSections) {
      for (const location of section.locations) {
        if (location.kind !== "directory") {
          continue;
        }
        const normalizedLocationPath = normalizeWorkspaceFilePath(
          location.path,
          this.store.root
        );
        if (!isWorkspaceFilePathWithinDirectory(path, normalizedLocationPath)) {
          continue;
        }
        if (
          !bestLocation ||
          normalizedLocationPath.length > bestLocation.path.length
        ) {
          bestLocation = {
            id: location.id,
            path: normalizedLocationPath
          };
        }
      }
    }
    return bestLocation?.id ?? null;
  }

  private clearSearchState(): void {
    if (
      this.store.searchQuery === "" &&
      this.store.searchEntries.length === 0 &&
      this.store.searchError === null &&
      !this.store.isSearching
    ) {
      return;
    }
    this.searchRequestSeq += 1;
    this.store.searchEntries = [];
    this.store.searchError = null;
    this.store.searchQuery = "";
    this.store.isSearching = false;
  }

  private async searchDirectoryEntries(
    query: string,
    selectedLocation: WorkspaceFileLocation | null
  ): Promise<WorkspaceFileSearchEntry[]> {
    if (!this.host.search) {
      return [];
    }
    const result = await this.host.search({
      query,
      workspaceID: this.store.workspaceID,
      ...(selectedLocation?.kind === "directory"
        ? { within: selectedLocation.path }
        : {})
    });
    return result.entries;
  }

  private async searchRecentEntries(
    query: string
  ): Promise<WorkspaceFileSearchEntry[]> {
    if (!this.host.listRecentEntries) {
      return [];
    }
    const listing = await this.host.listRecentEntries({
      limit: 100,
      workspaceID: this.store.workspaceID
    });
    const normalizedQuery = query.trim().toLowerCase();
    return listing.entries
      .filter((entry) => {
        const name = entry.name.toLowerCase();
        return name.includes(normalizedQuery);
      })
      .map((entry, index) => ({
        directoryPath: workspaceFileDirectory(entry.path, listing.root),
        kind: entry.kind,
        matchIndices: [],
        matchTarget: "basename",
        name: entry.name,
        path: entry.path,
        score: listing.entries.length - index
      }));
  }

  private observeStore(): void {
    if (this.unsubscribeStore) {
      return;
    }

    this.lastObservedEntries = this.store.entries;
    this.lastObservedSelectedPath = this.store.selectedPath;
    this.unsubscribeStore = subscribe(this.store, () => {
      if (this.isDisposed) {
        return;
      }
      if (
        this.lastObservedEntries === this.store.entries &&
        this.lastObservedSelectedPath === this.store.selectedPath
      ) {
        this.savePersistedStateIfChanged();
        return;
      }
      this.lastObservedEntries = this.store.entries;
      this.lastObservedSelectedPath = this.store.selectedPath;
      this.savePersistedStateIfChanged();
      void this.previewController.syncPreviewState();
      this.warmOpenWithApplicationsCache(this.store.entries);
    });
  }

  private warmOpenWithApplicationsCache(
    entries: WorkspaceFileManagerState["entries"]
  ): void {
    if (!this.host.listOpenWithApplications || this.store.isLoading) {
      return;
    }
    this.openWithApplicationsCache.scheduleWarmup(entries, (entry) =>
      this.listOpenWithApplications(entry)
    );
  }

  private savePersistedStateIfChanged(): void {
    if (!this.persistence?.save) {
      return;
    }
    const nextState = this.getPersistedState();
    const serialized = serializePersistedState(nextState);
    if (serialized === this.lastObservedPersistedState) {
      return;
    }
    this.lastObservedPersistedState = serialized;
    this.persistence.save(nextState);
  }

  private resolveErrorMessage(
    error: unknown,
    overrides: Record<string, string | undefined> = {}
  ): string {
    const filteredOverrides = Object.fromEntries(
      Object.entries(overrides).filter((entry) => entry[1] !== undefined)
    ) as Record<string, string>;
    if (this.host.resolveErrorMessage) {
      return this.host.resolveErrorMessage(error, filteredOverrides);
    }

    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code?: unknown }).code === "string"
    ) {
      const override = filteredOverrides[(error as { code: string }).code];
      if (override) {
        return override;
      }
    }

    return this.copy.t("unknownErrorMessage");
  }
}

function isPreviewStateForPath(
  previewState: WorkspaceFileManagerState["previewState"],
  path: string
): boolean {
  return "entry" in previewState && previewState.entry.path === path;
}

function serializePersistedState(
  state: WorkspaceFileManagerPersistedState
): string {
  return JSON.stringify(state);
}

function areWorkspaceFilePathsEqual(left: string, right: string): boolean {
  return normalizeWorkspaceFilePath(left) === normalizeWorkspaceFilePath(right);
}

function isWorkspaceFilePathWithinDirectory(
  path: string,
  directoryPath: string
): boolean {
  const normalizedPath = normalizeWorkspaceFilePath(path);
  const normalizedDirectoryPath = normalizeWorkspaceFilePath(directoryPath);
  return (
    normalizedPath === normalizedDirectoryPath ||
    normalizedDirectoryPath === "/" ||
    normalizedPath.startsWith(`${normalizedDirectoryPath}/`)
  );
}
