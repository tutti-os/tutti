import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useEffect, useState } from "react";
import { useServiceSnapshot } from "../bindings/useServiceSnapshot";
import type { MobileRootStackParamList } from "../navigation/mobileNavigation";
import type { MobileApplicationService } from "../services/mobileApplicationService";
import { DeviceScreenView } from "./DeviceScreenView";

type Props = NativeStackScreenProps<MobileRootStackParamList, "Devices"> & {
  application: MobileApplicationService;
};

export function DeviceScreen({ application, navigation }: Props) {
  const service = application.deviceService!;
  const model = useServiceSnapshot(service);
  const [manualPairingCode, setManualPairingCode] = useState("");
  const [manualPairingOpen, setManualPairingOpen] = useState(false);

  const submitManualPairingCode = async () => {
    if (await service.pairWithCode(manualPairingCode)) {
      setManualPairingCode("");
      setManualPairingOpen(false);
    }
  };
  const snapshot = useServiceSnapshot(application);

  useEffect(() => {
    if (
      snapshot.status !== "authenticated" ||
      !snapshot.device ||
      !snapshot.workspace
    ) {
      return;
    }
    navigation.navigate("Conversations", {
      pairingId: snapshot.device.pairingId,
      workspaceId: snapshot.workspace.id
    });
  }, [navigation, snapshot]);

  if (snapshot.status !== "authenticated") return null;

  return (
    <DeviceScreenView
      accountName={snapshot.session.name}
      manualPairingCode={manualPairingCode}
      manualPairingOpen={manualPairingOpen}
      model={model}
      onConnect={(pairing, device) => void service.connect(pairing, device)}
      onManualPairingCodeChange={setManualPairingCode}
      onManualPairingOpen={() => setManualPairingOpen(true)}
      onManualPairingSubmit={() => void submitManualPairingCode()}
      onRefresh={() => void service.refresh()}
      onScanPairingCode={() => void service.scanAndPair()}
      onSignOut={() => void application.signOut()}
    />
  );
}
