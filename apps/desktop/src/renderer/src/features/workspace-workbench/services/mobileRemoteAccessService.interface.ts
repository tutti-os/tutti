import { createDecorator } from "@tutti-os/infra/di";
import type {
  MobileRemoteAccessClient,
  MobileRemoteDevicePairing,
  MobileRemotePairingChallenge
} from "@tutti-os/client-tuttid-ts";

export type MobileRemoteAccessError = "start" | "status" | "list" | "revoke";

export interface MobileRemoteAccessStoreState {
  challenge: MobileRemotePairingChallenge | null;
  confirming: boolean;
  error: MobileRemoteAccessError | null;
  loadingPairings: boolean;
  pairings: MobileRemoteDevicePairing[];
  qrPayload: string | null;
  revokingPairingID: string | null;
  starting: boolean;
}

export interface IMobileRemoteAccessService {
  readonly _serviceBrand: undefined;
  readonly store: MobileRemoteAccessStoreState;
  cancelPairing(): void;
  dispose(): void;
  refreshPairings(): Promise<void>;
  revokePairing(pairingID: string): Promise<void>;
  startPairing(): Promise<void>;
}

export type MobileRemoteAccessServiceClient = MobileRemoteAccessClient;

export const IMobileRemoteAccessService =
  createDecorator<IMobileRemoteAccessService>("mobile-remote-access-service");
