import { useServiceSnapshot } from "../bindings/useServiceSnapshot";
import type { DeviceService } from "../services/deviceService";
import type { AccountSession } from "../services/mobileDomain";
import { DeviceScreenView } from "./DeviceScreenView";

export function DeviceScreen({
  onSignOut,
  service,
  session
}: {
  onSignOut(): Promise<void>;
  service: DeviceService;
  session: AccountSession;
}) {
  const model = useServiceSnapshot(service);
  return (
    <DeviceScreenView
      model={model}
      onConnect={(pairing, device) => void service.connect(pairing, device)}
      onManualPairingCodeChange={(value) => service.setManualPairingCode(value)}
      onManualPairingOpen={() => service.setManualPairingOpen(true)}
      onPair={(payload) => void service.pair(payload)}
      onRefresh={() => void service.refresh()}
      onSignOut={() => void onSignOut()}
      accountName={session.name}
    />
  );
}
