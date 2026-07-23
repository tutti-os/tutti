import type {
  IMobileRemoteAccessService,
  MobileRemoteAccessServiceClient
} from "../mobileRemoteAccessService.interface";
import { createMobileRemoteAccessStore } from "./mobileRemoteAccessStore.ts";

const defaultPairingStatusPollMs = 1_000;

export class MobileRemoteAccessService implements IMobileRemoteAccessService {
  readonly _serviceBrand: undefined;
  readonly store = createMobileRemoteAccessStore();

  private generation = 0;
  private readonly client: MobileRemoteAccessServiceClient;
  private readonly pollMs: number;

  constructor(
    client: MobileRemoteAccessServiceClient,
    pollMs = defaultPairingStatusPollMs
  ) {
    this.client = client;
    this.pollMs = pollMs;
  }

  async startPairing(): Promise<void> {
    if (this.store.starting || this.store.qrPayload) {
      return;
    }
    const generation = ++this.generation;
    this.store.starting = true;
    this.store.error = null;
    try {
      const started = await this.client.startMobileRemotePairing();
      if (generation !== this.generation) {
        return;
      }
      this.store.challenge = started.challenge;
      this.store.qrPayload = started.qrPayload;
      void this.pollChallenge(started.challenge.challengeId, generation);
    } catch {
      if (generation === this.generation) {
        this.store.error = "start";
      }
    } finally {
      if (generation === this.generation) {
        this.store.starting = false;
      }
    }
  }

  cancelPairing(): void {
    this.generation += 1;
    this.store.challenge = null;
    this.store.confirming = false;
    this.store.qrPayload = null;
    this.store.starting = false;
  }

  async refreshPairings(): Promise<void> {
    if (this.store.loadingPairings) {
      return;
    }
    this.store.loadingPairings = true;
    this.store.error = null;
    try {
      const response = await this.client.listMobileRemotePairings();
      this.store.pairings = response.pairings;
    } catch {
      this.store.error = "list";
    } finally {
      this.store.loadingPairings = false;
    }
  }

  async revokePairing(pairingID: string): Promise<void> {
    if (!pairingID || this.store.revokingPairingID) {
      return;
    }
    this.store.revokingPairingID = pairingID;
    this.store.error = null;
    try {
      const revoked = await this.client.revokeMobileRemotePairing(pairingID);
      this.store.pairings = this.store.pairings.map((pairing) =>
        pairing.pairingId === pairingID ? revoked : pairing
      );
    } catch {
      this.store.error = "revoke";
    } finally {
      this.store.revokingPairingID = null;
    }
  }

  dispose(): void {
    this.cancelPairing();
  }

  private async pollChallenge(
    challengeID: string,
    generation: number
  ): Promise<void> {
    try {
      while (generation === this.generation) {
        await delay(this.pollMs);
        if (generation !== this.generation) {
          return;
        }
        if (this.challengeExpired()) {
          this.clearPairingChallenge();
          return;
        }
        const response =
          await this.client.getMobileRemotePairingChallenge(challengeID);
        if (generation !== this.generation) {
          return;
        }
        this.store.challenge = response.challenge;
        if (response.challenge.state === "awaiting_confirmation") {
          this.store.confirming = true;
          const confirmed =
            await this.client.confirmMobileRemotePairing(challengeID);
          if (generation !== this.generation) {
            return;
          }
          this.store.challenge = confirmed.challenge;
          this.store.qrPayload = null;
          this.store.confirming = false;
          await this.refreshPairings();
          return;
        }
        if (
          response.challenge.state === "confirmed" ||
          Date.parse(response.challenge.expiresAt) <= Date.now()
        ) {
          this.store.qrPayload = null;
          return;
        }
      }
    } catch {
      if (generation === this.generation) {
        this.clearPairingChallenge();
        this.store.error = "status";
      }
    }
  }

  private challengeExpired(): boolean {
    const expiresAt = Date.parse(this.store.challenge?.expiresAt ?? "");
    return Number.isFinite(expiresAt) && expiresAt <= Date.now();
  }

  private clearPairingChallenge(): void {
    this.store.challenge = null;
    this.store.confirming = false;
    this.store.qrPayload = null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
