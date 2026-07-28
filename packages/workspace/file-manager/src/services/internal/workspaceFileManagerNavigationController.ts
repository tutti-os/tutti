import {
  normalizeWorkspaceFilePath,
  sortWorkspaceEntries,
  workspaceFileDirectory,
  workspaceFilePathHasHiddenSegment
} from "../workspaceFileManagerModel.ts";
import type { WorkspaceFileManagerHost } from "../workspaceFileManagerHost.interface.ts";
import type { WorkspaceFileManagerState } from "../workspaceFileManagerTypes.ts";

export interface WorkspaceFileManagerNavigationControllerInput {
  host: WorkspaceFileManagerHost;
  resolveErrorMessage: (error: unknown) => string;
  store: WorkspaceFileManagerState;
}

export class WorkspaceFileManagerNavigationController {
  private readonly host: WorkspaceFileManagerHost;
  private readonly resolveErrorMessage: (error: unknown) => string;
  private readonly store: WorkspaceFileManagerState;
  private requestSeq = 0;
  /** Counts performLoad/reveal/replace calls so superseded requests cannot leave isLoading latched. */
  private activeLoadCount = 0;
  /**
   * Same-path loads share one in-flight promise. Concurrent initialize/reveal/
   * remount callers used to bump requestSeq and let a faster empty response
   * discard a slower successful listing.
   */
  private readonly inFlightLoadByPath = new Map<string, Promise<void>>();

  constructor(input: WorkspaceFileManagerNavigationControllerInput) {
    this.host = input.host;
    this.resolveErrorMessage = input.resolveErrorMessage;
    this.store = input.store;
  }

  private beginLoad(): number {
    const requestID = ++this.requestSeq;
    this.activeLoadCount += 1;
    this.store.isLoading = true;
    this.store.error = null;
    return requestID;
  }

  private endLoad(requestID: number): void {
    this.activeLoadCount = Math.max(0, this.activeLoadCount - 1);
    if (requestID === this.requestSeq || this.activeLoadCount === 0) {
      this.store.isLoading = false;
    }
  }

  async goBack(): Promise<void> {
    const previous = this.store.navigationBackStack.pop();
    if (!previous) {
      return;
    }
    this.store.navigationForwardStack.push(this.store.currentDirectoryPath);
    await this.replaceDirectory(previous);
  }

  async goForward(): Promise<void> {
    const next = this.store.navigationForwardStack.pop();
    if (!next) {
      return;
    }
    this.store.navigationBackStack.push(this.store.currentDirectoryPath);
    await this.replaceDirectory(next);
  }

  async loadDirectory(path = this.store.currentDirectoryPath): Promise<void> {
    const normalizedPath = normalizeWorkspaceFilePath(path, this.store.root);
    const existing = this.inFlightLoadByPath.get(normalizedPath);
    if (existing) {
      await existing;
      return;
    }

    const run = this.performLoadDirectory(normalizedPath);
    this.inFlightLoadByPath.set(normalizedPath, run);
    try {
      await run;
    } finally {
      if (this.inFlightLoadByPath.get(normalizedPath) === run) {
        this.inFlightLoadByPath.delete(normalizedPath);
      }
    }
  }

  async refresh(): Promise<void> {
    await this.loadDirectory(this.store.currentDirectoryPath);
  }

  private async performLoadDirectory(normalizedPath: string): Promise<void> {
    const requestID = this.beginLoad();

    try {
      const listing = await this.host.listDirectory({
        includeHidden: workspaceFilePathHasHiddenSegment(normalizedPath),
        path: this.resolveRequestPath(normalizedPath),
        workspaceID: this.store.workspaceID
      });
      if (requestID !== this.requestSeq) {
        // Same-path coalescing covers the common remount race. Still recover
        // when a superseded response has entries and the store is empty for
        // that directory (e.g. empty prefetch won, then network returned data).
        if (
          listing.entries.length > 0 &&
          this.store.entries.length === 0 &&
          this.store.error === null &&
          normalizeWorkspaceFilePath(listing.directoryPath, listing.root) ===
            normalizeWorkspaceFilePath(
              this.store.currentDirectoryPath,
              this.store.root
            )
        ) {
          this.store.root = normalizeWorkspaceFilePath(listing.root);
          this.store.currentDirectoryPath = listing.directoryPath;
          this.store.entries = sortWorkspaceEntries(listing.entries);
          this.store.directoryExpansionByPath = {};
          this.store.expandedDirectoryPaths = {};
        }
        return;
      }

      const previousDirectoryPath = this.store.currentDirectoryPath;
      if (
        previousDirectoryPath !== listing.directoryPath &&
        previousDirectoryPath !== "/"
      ) {
        this.store.navigationBackStack.push(this.store.currentDirectoryPath);
        this.store.navigationForwardStack = [];
      }
      this.store.root = normalizeWorkspaceFilePath(listing.root);
      this.store.currentDirectoryPath = listing.directoryPath;
      this.store.entries = sortWorkspaceEntries(listing.entries);
      this.store.directoryExpansionByPath = {};
      this.store.expandedDirectoryPaths = {};
      this.store.selectedPath = null;
    } catch (error) {
      if (requestID === this.requestSeq) {
        this.store.error = this.resolveErrorMessage(error);
      }
    } finally {
      this.endLoad(requestID);
    }
  }

  async revealPath(path: string): Promise<void> {
    const normalizedPath = normalizeWorkspaceFilePath(path, this.store.root);
    const directoryPath = workspaceFileDirectory(
      normalizedPath,
      this.store.root
    );
    const requestID = this.beginLoad();

    try {
      const listing = await this.host.listDirectory({
        includeHidden: workspaceFilePathHasHiddenSegment(normalizedPath),
        path: this.resolveRequestPath(directoryPath),
        workspaceID: this.store.workspaceID
      });
      if (requestID !== this.requestSeq) {
        return;
      }

      const previousDirectoryPath = this.store.currentDirectoryPath;
      if (
        previousDirectoryPath !== listing.directoryPath &&
        previousDirectoryPath !== "/"
      ) {
        this.store.navigationBackStack.push(this.store.currentDirectoryPath);
        this.store.navigationForwardStack = [];
      }
      this.store.root = normalizeWorkspaceFilePath(listing.root);
      this.store.currentDirectoryPath = listing.directoryPath;
      this.store.entries = sortWorkspaceEntries(listing.entries);
      this.store.directoryExpansionByPath = {};
      this.store.expandedDirectoryPaths = {};
      this.store.selectedPath = normalizedPath;
    } catch (error) {
      if (requestID === this.requestSeq) {
        this.store.error = this.resolveErrorMessage(error);
      }
    } finally {
      this.endLoad(requestID);
    }
  }

  private async replaceDirectory(path: string): Promise<void> {
    const normalizedPath = normalizeWorkspaceFilePath(path, this.store.root);
    const requestID = this.beginLoad();
    try {
      const listing = await this.host.listDirectory({
        includeHidden: workspaceFilePathHasHiddenSegment(normalizedPath),
        path: this.resolveRequestPath(normalizedPath),
        workspaceID: this.store.workspaceID
      });
      if (requestID !== this.requestSeq) {
        return;
      }
      this.store.root = normalizeWorkspaceFilePath(listing.root);
      this.store.currentDirectoryPath = listing.directoryPath;
      this.store.entries = sortWorkspaceEntries(listing.entries);
      this.store.directoryExpansionByPath = {};
      this.store.expandedDirectoryPaths = {};
      this.store.selectedPath = null;
    } catch (error) {
      if (requestID === this.requestSeq) {
        this.store.error = this.resolveErrorMessage(error);
      }
    } finally {
      this.endLoad(requestID);
    }
  }

  private resolveRequestPath(path: string): string {
    if (this.store.root === "/" && path === "/") {
      return "";
    }
    return path;
  }
}
