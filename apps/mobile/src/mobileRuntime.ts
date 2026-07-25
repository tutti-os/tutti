import { InstantiationService, ServiceCollection } from "@tutti-os/infra/di";
import { createMobileServicePorts } from "./native/createMobileServicePorts";
import { MobileApplicationService } from "./services/mobileApplicationService";
import { IMobileApplicationService } from "./services/mobileServiceIdentifiers";

const rootServices = new ServiceCollection();
const rootContainer = new InstantiationService(rootServices);

export const mobileApplicationService = new MobileApplicationService(
  rootContainer,
  createMobileServicePorts()
);
rootServices.set(IMobileApplicationService, mobileApplicationService);

void mobileApplicationService.start();
