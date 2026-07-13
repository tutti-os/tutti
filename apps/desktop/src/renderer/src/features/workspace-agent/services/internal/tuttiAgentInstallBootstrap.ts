import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import { desktopInstallBootstrapProviders } from "./desktopManagedAgentProviders.ts";

const installActionId = "install";
const defaultFailureBackoffMs = 6 * 60 * 60 * 1000;

const attemptedInstallThisSession = new Set<WorkspaceAgentProvider>();
const bootstrapInFlight = new Map<WorkspaceAgentProvider, Promise<void>>();

export interface ManagedAgentInstallBootstrapOptions {
  backoffMs?: number;
  now?: () => number;
  storage?: ManagedAgentInstallBootstrapStorage | null;
}

export interface ManagedAgentInstallBootstrapStorage {
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

interface BootstrapFailureState {
  failureReason?: string;
  lastAttemptAt?: number;
  lastStatus?: string;
  packageVersion?: string;
}

export function startManagedAgentInstallBootstraps(
  service: IAgentProviderStatusService,
  options: ManagedAgentInstallBootstrapOptions = {}
): void {
  for (const provider of desktopInstallBootstrapProviders) {
    startManagedAgentInstallBootstrap(service, provider, options);
  }
}

function startManagedAgentInstallBootstrap(
  service: IAgentProviderStatusService,
  provider: WorkspaceAgentProvider,
  options: ManagedAgentInstallBootstrapOptions
): void {
  if (
    attemptedInstallThisSession.has(provider) ||
    bootstrapInFlight.has(provider)
  ) {
    return;
  }
  const request = runManagedAgentInstallBootstrap(service, provider, options)
    .catch(() => {})
    .finally(() => {
      bootstrapInFlight.delete(provider);
    });
  bootstrapInFlight.set(provider, request);
}

export function resetManagedAgentInstallBootstrapForTests(): void {
  attemptedInstallThisSession.clear();
  bootstrapInFlight.clear();
}

export async function runManagedAgentInstallBootstrap(
  service: IAgentProviderStatusService,
  provider: WorkspaceAgentProvider,
  options: ManagedAgentInstallBootstrapOptions = {}
): Promise<void> {
  const now = options.now?.() ?? Date.now();
  const storage = resolveBootstrapStorage(options.storage);
  if (
    hasRecentFailure(
      storage,
      provider,
      now,
      options.backoffMs ?? defaultFailureBackoffMs
    )
  ) {
    return;
  }

  let response;
  try {
    response = await service.ensureLoaded({
      providers: [provider]
    });
  } catch (error) {
    writeBootstrapFailure(storage, provider, {
      failureReason: error instanceof Error ? error.message : String(error),
      lastAttemptAt: now,
      lastStatus: "failed",
      packageVersion: "latest"
    });
    throw error;
  }
  const status =
    service.getStatus(provider) ??
    response?.providers.find((candidate) => candidate.provider === provider) ??
    null;
  if (!status) {
    return;
  }
  if (status.availability.status === "ready") {
    clearBootstrapFailure(storage, provider);
    return;
  }
  if (status.availability.status !== "not_installed") {
    return;
  }
  if (service.isActionPending(provider, installActionId)) {
    return;
  }
  if (!hasInstallAction(status)) {
    return;
  }

  try {
    attemptedInstallThisSession.add(provider);
    await service.runAction(provider, installActionId);
    clearBootstrapFailure(storage, provider);
    await service.refresh([provider]).catch(() => {});
  } catch (error) {
    writeBootstrapFailure(storage, provider, {
      failureReason: error instanceof Error ? error.message : String(error),
      lastAttemptAt: now,
      lastStatus: "failed",
      packageVersion: "latest"
    });
  }
}

function hasInstallAction(status: AgentProviderStatus): boolean {
  return status.actions.some((action) => action.id === installActionId);
}

function resolveBootstrapStorage(
  storage: ManagedAgentInstallBootstrapOptions["storage"]
): ManagedAgentInstallBootstrapStorage | null {
  if (storage !== undefined) {
    return storage;
  }
  return typeof localStorage === "undefined" ? null : localStorage;
}

function hasRecentFailure(
  storage: ManagedAgentInstallBootstrapStorage | null,
  provider: WorkspaceAgentProvider,
  now: number,
  backoffMs: number
): boolean {
  const state = readBootstrapFailure(storage, provider);
  if (
    state?.lastStatus !== "failed" ||
    typeof state.lastAttemptAt !== "number"
  ) {
    return false;
  }
  return now - state.lastAttemptAt < backoffMs;
}

function readBootstrapFailure(
  storage: ManagedAgentInstallBootstrapStorage | null,
  provider: WorkspaceAgentProvider
): BootstrapFailureState | null {
  if (!storage) {
    return null;
  }
  try {
    const raw = storage.getItem(bootstrapStorageKey(provider));
    return raw ? (JSON.parse(raw) as BootstrapFailureState) : null;
  } catch {
    return null;
  }
}

function writeBootstrapFailure(
  storage: ManagedAgentInstallBootstrapStorage | null,
  provider: WorkspaceAgentProvider,
  state: BootstrapFailureState
): void {
  if (!storage) {
    return;
  }
  try {
    storage.setItem(bootstrapStorageKey(provider), JSON.stringify(state));
  } catch {
    // Best-effort bootstrap metadata must never block manual setup.
  }
}

function clearBootstrapFailure(
  storage: ManagedAgentInstallBootstrapStorage | null,
  provider: WorkspaceAgentProvider
): void {
  if (!storage) {
    return;
  }
  try {
    storage.removeItem(bootstrapStorageKey(provider));
  } catch {
    // Best-effort cleanup.
  }
}

function bootstrapStorageKey(provider: WorkspaceAgentProvider): string {
  return `tutti.agentBootstrap.${provider}`;
}
