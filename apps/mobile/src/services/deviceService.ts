import type { AccountSession, DevicePairing, UserDevice } from "./mobileDomain";
import { ObservableService } from "./observableService";
import type {
  ClockPort,
  DeviceSecurityPort,
  PairingPort
} from "./servicePorts";

export type DeviceErrorCode =
  | "camera_permission_required"
  | "connection_failed"
  | "pairing_failed"
  | "request_failed"
  | "scanner_unavailable"
  | null;

export interface ConnectedDevice {
  name: string;
  pairingId: string;
}

export interface DeviceSnapshot {
  connectingPairingId: string | null;
  devices: readonly UserDevice[];
  errorCode: DeviceErrorCode;
  manualPairingCode: string;
  manualPairingOpen: boolean;
  pairingState: "idle" | "claiming" | "waiting" | "confirmed";
  pairings: readonly DevicePairing[];
  refreshing: boolean;
}

export class DeviceService extends ObservableService<DeviceSnapshot> {
  readonly _serviceBrand: undefined;
  private connectionGeneration = 0;
  private pairingGeneration = 0;
  private started = false;
  private disposed = false;
  private snapshot: DeviceSnapshot = {
    connectingPairingId: null,
    devices: [],
    errorCode: null,
    manualPairingCode: "",
    manualPairingOpen: false,
    pairingState: "idle",
    pairings: [],
    refreshing: false
  };

  constructor(
    private readonly session: AccountSession,
    private readonly pairing: PairingPort,
    private readonly security: DeviceSecurityPort,
    private readonly clock: ClockPort,
    private readonly onConnected: (device: ConnectedDevice) => Promise<void>
  ) {
    super();
  }

  getSnapshot = (): DeviceSnapshot => this.snapshot;

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.refresh();
  }

  setManualPairingCode(value: string): void {
    this.patch({ manualPairingCode: value });
  }

  setManualPairingOpen(open: boolean): void {
    this.patch({ manualPairingOpen: open });
  }

  async refresh(): Promise<void> {
    if (this.disposed || this.snapshot.refreshing) return;
    this.patch({ errorCode: null, refreshing: true });
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
        this.patch({ errorCode: "request_failed", refreshing: false });
      }
    }
  }

  async pair(manualPayload?: string): Promise<void> {
    const generation = ++this.pairingGeneration;
    this.patch({ errorCode: null, pairingState: "claiming" });
    try {
      const rawPayload =
        manualPayload?.trim() || (await this.security.scanQRCode());
      const payload = this.pairing.parsePairingQR(rawPayload);
      if (!this.isPairingCurrent(generation)) return;
      const challenge = await this.pairing.claimPairing(
        this.session.sessionId,
        payload
      );
      if (!this.isPairingCurrent(generation)) return;
      this.patch({ pairingState: "waiting" });
      const deadline = Date.parse(challenge.expiresAt);
      while (this.clock.now() < deadline) {
        await this.wait(1_000);
        if (!this.isPairingCurrent(generation)) return;
        const latest = await this.pairing.getPairingChallenge(
          this.session.sessionId,
          payload.challengeId
        );
        if (latest.state === "confirmed") {
          if (!this.isPairingCurrent(generation)) return;
          this.patch({
            manualPairingCode: "",
            manualPairingOpen: false,
            pairingState: "confirmed"
          });
          await this.refresh();
          return;
        }
      }
      throw new Error("pairing challenge expired");
    } catch (cause) {
      if (!this.isPairingCurrent(generation)) return;
      const code =
        typeof cause === "object" && cause !== null && "code" in cause
          ? String(cause.code)
          : "";
      this.patch({
        errorCode:
          code === "SCAN_CANCELLED"
            ? null
            : code === "SCANNER_PERMISSION_DENIED"
              ? "camera_permission_required"
              : code === "SCANNER_UNAVAILABLE" || code === "SCAN_FAILED"
                ? "scanner_unavailable"
                : "pairing_failed",
        pairingState: "idle"
      });
    }
  }

  async connect(pairing: DevicePairing, device?: UserDevice): Promise<void> {
    if (this.snapshot.connectingPairingId !== null) return;
    const generation = ++this.connectionGeneration;
    this.patch({
      connectingPairingId: pairing.pairingId,
      errorCode: null
    });
    try {
      await this.pairing.connectPairedDevice(
        this.session.sessionId,
        pairing.pairingId,
        () => this.isConnectionCurrent(generation)
      );
      if (!this.isConnectionCurrent(generation)) return;
      await this.onConnected({
        name: device?.displayName || device?.reportedName || "",
        pairingId: pairing.pairingId
      });
    } catch {
      if (this.isConnectionCurrent(generation)) {
        this.patch({ errorCode: "connection_failed" });
      }
    } finally {
      if (this.isConnectionCurrent(generation)) {
        this.patch({ connectingPairingId: null });
      }
    }
  }

  pause(): void {
    this.pairingGeneration += 1;
    this.connectionGeneration += 1;
    this.patch({
      connectingPairingId: null,
      pairingState:
        this.snapshot.pairingState === "claiming" ||
        this.snapshot.pairingState === "waiting"
          ? "idle"
          : this.snapshot.pairingState
    });
  }

  resume(): void {
    if (!this.disposed) void this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.clearListeners();
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
