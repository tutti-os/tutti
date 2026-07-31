import type {
  AccountSession,
  DevicePairing,
  DevicePairingPhase,
  UserDevice
} from "./mobileDomain";
import { ObservableService } from "./observableService";
import { parsePairingQR } from "./pairingProtocol";
import {
  PAIRING_OPERATION_SUSPENDED,
  type ClockPort,
  type MobileDiagnosticsPort,
  type PairingPort,
  type QRCodeScanOperation,
  type QRCodeScannerPort
} from "./servicePorts";

export type DeviceErrorCode =
  | "camera_permission_required"
  | "connection_failed"
  | "pairing_failed"
  | "request_failed"
  | "scanner_unavailable"
  | "workspace_unavailable"
  | null;

export class DeviceConnectionSetupError extends Error {
  constructor(readonly errorCode: "workspace_unavailable") {
    super(errorCode);
    this.name = "DeviceConnectionSetupError";
  }
}

export interface ConnectedDevice {
  name: string;
  pairingId: string;
}

export interface DeviceSnapshot {
  connectingPairingId: string | null;
  devices: readonly UserDevice[];
  errorCode: DeviceErrorCode;
  pairingState: DevicePairingPhase;
  pairings: readonly DevicePairing[];
  refreshing: boolean;
}

export class DeviceService extends ObservableService<DeviceSnapshot> {
  readonly _serviceBrand: undefined;
  private connectionGeneration = 0;
  private pairingGeneration = 0;
  private remoteOperationsEnabled = true;
  private remoteOperationsRevision = 0;
  private readonly remoteResumeWaiters = new Set<() => void>();
  private scanOperation: QRCodeScanOperation | null = null;
  private started = false;
  private disposed = false;
  private snapshot: DeviceSnapshot = {
    connectingPairingId: null,
    devices: [],
    errorCode: null,
    pairingState: "idle",
    pairings: [],
    refreshing: false
  };

  constructor(
    private readonly session: AccountSession,
    private readonly pairing: PairingPort,
    private readonly qrCodeScanner: QRCodeScannerPort,
    private readonly diagnostics: MobileDiagnosticsPort,
    private readonly clock: ClockPort,
    private readonly onConnected: (device: ConnectedDevice) => Promise<void>
  ) {
    super();
  }

  getSnapshot = (): DeviceSnapshot => this.snapshot;

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    if (this.remoteOperationsEnabled) {
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (
      this.disposed ||
      !this.remoteOperationsEnabled ||
      this.snapshot.refreshing
    ) {
      return;
    }
    this.patch({
      errorCode:
        this.snapshot.errorCode === "request_failed"
          ? null
          : this.snapshot.errorCode,
      refreshing: true
    });
    try {
      const [registered, pairings, devices] = await Promise.all([
        this.pairing.registerCurrentDevice(this.session.sessionId),
        this.pairing.listPairings(this.session.sessionId),
        this.pairing.listDevices(this.session.sessionId)
      ]);
      if (this.disposed) return;
      this.patch({
        devices,
        pairings: pairings.filter(
          (pairing) =>
            pairing.state === "active" &&
            pairing.controllerUserDeviceId === registered.userDeviceId
        ),
        refreshing: false
      });
    } catch {
      if (!this.disposed) {
        this.patch({
          errorCode: this.snapshot.errorCode ?? "request_failed",
          refreshing: false
        });
      }
    }
  }

  async scanAndPair(): Promise<void> {
    if (!this.canStartPairing()) return;
    this.transitionPairing("scanning", { errorCode: null }, "scanner");
    const operation = this.qrCodeScanner.start();
    this.scanOperation = operation;
    let rawPayload: string;
    try {
      rawPayload = await operation.result;
    } catch (cause) {
      if (!this.disposed && this.snapshot.pairingState === "scanning") {
        const errorCode = this.scannerErrorCode(cause);
        this.transitionPairing("idle", { errorCode });
        this.diagnostics.record({
          errorCode,
          name: "device_pairing.failed",
          stage: "scanner"
        });
      }
      return;
    } finally {
      if (this.scanOperation === operation) {
        this.scanOperation = null;
      }
    }
    if (this.disposed || this.snapshot.pairingState !== "scanning") return;
    await this.pairWithRawPayload(rawPayload, "scanner");
  }

  async pairWithCode(rawPayload: string): Promise<boolean> {
    if (!this.canStartPairing()) return false;
    return this.pairWithRawPayload(rawPayload.trim(), "manual");
  }

  private async pairWithRawPayload(
    rawPayload: string,
    source: "manual" | "scanner"
  ): Promise<boolean> {
    const generation = ++this.pairingGeneration;
    if (source === "manual") {
      this.transitionPairing("claiming", { errorCode: null }, source);
    }
    try {
      const payload = parsePairingQR(rawPayload);
      if (!(await this.waitForRemoteOperations(generation))) return false;
      if (source === "scanner") {
        this.transitionPairing("claiming", { errorCode: null }, source);
      }
      const challenge = await this.claimWhenRemoteEnabled(generation, payload);
      if (!this.isPairingCurrent(generation)) return false;
      if (!(await this.waitForRemoteOperations(generation))) return false;
      if (challenge.state === "confirmed") {
        this.transitionPairing("confirmed");
        await this.refresh();
        return true;
      }
      this.transitionPairing("waiting");
      const deadline = Date.parse(challenge.expiresAt);
      while (this.clock.now() < deadline) {
        await this.wait(1_000);
        if (!this.isPairingCurrent(generation)) return false;
        const latest = await this.pollPairingChallengeWhenEnabled(
          generation,
          challenge.challengeId
        );
        if (latest.state === "confirmed") {
          if (!this.isPairingCurrent(generation)) return false;
          this.transitionPairing("confirmed");
          await this.refresh();
          return true;
        }
      }
      throw new Error("pairing challenge expired");
    } catch {
      if (!this.isPairingCurrent(generation)) return false;
      this.transitionPairing("idle", { errorCode: "pairing_failed" });
      this.diagnostics.record({
        errorCode: "pairing_failed",
        name: "device_pairing.failed",
        stage: "pairing"
      });
      return false;
    }
  }

  connect(pairing: DevicePairing, device?: UserDevice): Promise<boolean> {
    return this.connectDevice({
      name: device?.displayName || device?.reportedName || "",
      pairingId: pairing.pairingId
    });
  }

  reconnect(device: ConnectedDevice): Promise<boolean> {
    return this.connectDevice(device);
  }

  private async connectDevice(device: ConnectedDevice): Promise<boolean> {
    if (
      this.disposed ||
      !this.remoteOperationsEnabled ||
      this.snapshot.connectingPairingId !== null
    ) {
      return false;
    }
    const generation = ++this.connectionGeneration;
    this.patch({
      connectingPairingId: device.pairingId,
      errorCode: null
    });
    try {
      await this.pairing.connectPairedDevice(
        this.session.sessionId,
        device.pairingId,
        () => this.isConnectionCurrent(generation)
      );
      if (!this.isConnectionCurrent(generation)) return false;
      await this.onConnected(device);
      return this.isConnectionCurrent(generation);
    } catch (cause) {
      if (this.isConnectionCurrent(generation)) {
        this.patch({
          errorCode:
            cause instanceof DeviceConnectionSetupError
              ? cause.errorCode
              : "connection_failed"
        });
      }
      return false;
    } finally {
      if (this.isConnectionCurrent(generation)) {
        this.patch({ connectingPairingId: null });
      }
    }
  }

  suspendRemoteOperations(): void {
    if (this.disposed || !this.remoteOperationsEnabled) return;
    this.remoteOperationsEnabled = false;
    this.remoteOperationsRevision += 1;
    this.connectionGeneration += 1;
    const suspendedPairingState =
      this.snapshot.pairingState === "claiming" ||
      this.snapshot.pairingState === "waiting"
        ? this.snapshot.pairingState
        : null;
    if (suspendedPairingState) {
      this.diagnostics.record({
        name: "device_pairing.remote_suspended",
        phase: suspendedPairingState
      });
    }
    this.patch({ connectingPairingId: null });
  }

  resumeRemoteOperations(): void {
    if (this.disposed) return;
    this.remoteOperationsEnabled = true;
    this.releaseRemoteResumeWaiters();
    void this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pairingGeneration += 1;
    this.connectionGeneration += 1;
    this.releaseRemoteResumeWaiters();
    const scanOperation = this.scanOperation;
    this.scanOperation = null;
    void scanOperation?.cancel().catch(() => undefined);
    this.clearListeners();
  }

  private canStartPairing(): boolean {
    return (
      !this.disposed &&
      this.remoteOperationsEnabled &&
      (this.snapshot.pairingState === "idle" ||
        this.snapshot.pairingState === "confirmed")
    );
  }

  private scannerErrorCode(
    cause: unknown
  ): "camera_permission_required" | "scanner_unavailable" | null {
    const code =
      typeof cause === "object" && cause !== null && "code" in cause
        ? String(cause.code)
        : "";
    if (code === "SCAN_CANCELLED") return null;
    if (code === "SCANNER_PERMISSION_DENIED") {
      return "camera_permission_required";
    }
    return "scanner_unavailable";
  }

  private transitionPairing(
    pairingState: DeviceSnapshot["pairingState"],
    patch: Partial<DeviceSnapshot> = {},
    source?: "manual" | "scanner"
  ): void {
    this.patch({ ...patch, pairingState });
    this.diagnostics.record({
      name: "device_pairing.phase_changed",
      phase: pairingState,
      ...(source ? { source } : {})
    });
  }

  private async claimWhenRemoteEnabled(
    generation: number,
    payload: ReturnType<typeof parsePairingQR>
  ) {
    while (this.isPairingCurrent(generation)) {
      if (!(await this.waitForRemoteOperations(generation))) {
        throw new Error("pairing was cancelled");
      }
      const remoteOperationsRevision = this.remoteOperationsRevision;
      try {
        return await this.pairing.claimPairing(
          this.session.sessionId,
          payload,
          () =>
            this.isPairingCurrent(generation) && this.remoteOperationsEnabled
        );
      } catch (cause) {
        if (!this.isPairingCurrent(generation)) throw cause;
        if (this.isPairingOperationSuspended(cause)) continue;
        if (remoteOperationsRevision !== this.remoteOperationsRevision) {
          if (!(await this.waitForRemoteOperations(generation))) throw cause;
          const latest = await this.pollPairingChallengeWhenEnabled(
            generation,
            payload.challengeId
          );
          if (
            latest.state === "awaiting_confirmation" ||
            latest.state === "confirmed"
          ) {
            return latest;
          }
        }
        throw cause;
      }
    }
    throw new Error("pairing was cancelled");
  }

  private async pollPairingChallengeWhenEnabled(
    generation: number,
    challengeId: string
  ) {
    while (this.isPairingCurrent(generation)) {
      if (!(await this.waitForRemoteOperations(generation))) {
        throw new Error("pairing was cancelled");
      }
      const remoteOperationsRevision = this.remoteOperationsRevision;
      try {
        const challenge = await this.pairing.getPairingChallenge(
          this.session.sessionId,
          challengeId
        );
        if (!(await this.waitForRemoteOperations(generation))) {
          throw new Error("pairing was cancelled");
        }
        return challenge;
      } catch (cause) {
        if (!this.isPairingCurrent(generation)) throw cause;
        if (remoteOperationsRevision === this.remoteOperationsRevision) {
          throw cause;
        }
      }
    }
    throw new Error("pairing was cancelled");
  }

  private isPairingOperationSuspended(cause: unknown): boolean {
    return (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === PAIRING_OPERATION_SUSPENDED
    );
  }

  private async waitForRemoteOperations(generation: number): Promise<boolean> {
    while (!this.remoteOperationsEnabled && this.isPairingCurrent(generation)) {
      await new Promise<void>((resolve) => {
        this.remoteResumeWaiters.add(resolve);
      });
    }
    return this.remoteOperationsEnabled && this.isPairingCurrent(generation);
  }

  private releaseRemoteResumeWaiters(): void {
    for (const resolve of this.remoteResumeWaiters) resolve();
    this.remoteResumeWaiters.clear();
  }

  private isPairingCurrent(generation: number): boolean {
    return !this.disposed && generation === this.pairingGeneration;
  }

  private isConnectionCurrent(generation: number): boolean {
    return !this.disposed && generation === this.connectionGeneration;
  }

  private wait(delayMs: number): Promise<void> {
    return new Promise((resolve) => {
      this.clock.schedule(delayMs, resolve);
    });
  }

  private patch(patch: Partial<DeviceSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emitChange();
  }
}
