import { InstantiationService, ServiceCollection } from "@tutti-os/infra/di";
import { createMobileServicePorts } from "./native/createMobileServicePorts";
import { mobileSecurity } from "./native/mobileNative";
import { createMobileThemePreferencePort } from "./native/mobileThemePreferencePort";
import { createMobileUpdateInstaller } from "./native/mobileUpdateNativeBridge";
import { mobileUpdateFeedURL } from "./config";
import { MobileApplicationService } from "./services/mobileApplicationService";
import { MobileUpdateService } from "./services/mobileUpdateService";
import { IMobileApplicationService } from "./services/mobileServiceIdentifiers";
import { MobileThemePreferenceService } from "./services/mobileThemePreferenceService";

const rootServices = new ServiceCollection();
const rootContainer = new InstantiationService(rootServices);

export const mobileApplicationService = new MobileApplicationService(
  rootContainer,
  createMobileServicePorts()
);
export const mobileThemePreferenceService = new MobileThemePreferenceService(
  createMobileThemePreferencePort()
);
export const mobileUpdateService = new MobileUpdateService({
  currentVersionCode: mobileSecurity.clientVersionCode ?? 0,
  currentVersionName: mobileSecurity.clientVersion,
  feedURL: mobileUpdateFeedURL,
  installer: createMobileUpdateInstaller()
});
rootServices.set(IMobileApplicationService, mobileApplicationService);

void mobileApplicationService.start();
