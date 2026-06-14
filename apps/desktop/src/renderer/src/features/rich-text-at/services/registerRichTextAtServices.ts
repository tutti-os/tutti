import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import { DesktopRichTextAtService } from "./internal/desktopRichTextAtService";
import { IDesktopRichTextAtService } from "./richTextAtService.interface";

export interface RichTextAtServiceRegistrationInput {
  tuttidClient: TuttidClient;
}

export function registerRichTextAtServices(
  registry: ServiceRegistry,
  input: RichTextAtServiceRegistrationInput
): IDesktopRichTextAtService {
  const service = new DesktopRichTextAtService({
    tuttidClient: input.tuttidClient
  });
  registry.registerInstance(IDesktopRichTextAtService, service);
  return service;
}
