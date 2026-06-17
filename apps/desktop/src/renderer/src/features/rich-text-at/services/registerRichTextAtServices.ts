import type { ServiceRegistry } from "@tutti-os/infra/di";
import type { TuttidClient } from "@tutti-os/client-tuttid-ts";
import type { WorkspaceAppCenterApp } from "@tutti-os/workspace-app-center";
import { DesktopRichTextAtService } from "./internal/desktopRichTextAtService";
import { IDesktopRichTextAtService } from "./richTextAtService.interface";
import type { DesktopAgentSessionStatusView } from "../providers/desktopAgentSessionMentionProvider";

export interface RichTextAtServiceRegistrationInput {
  tuttidClient: TuttidClient;
  appCenterApps?: () => readonly WorkspaceAppCenterApp[];
  getLocale?: () => string;
  resolveAgentIconUrl?: (provider: string) => string;
  userAvatarPlaceholderUrl?: string;
  resolveSessionStatusView?: (
    status: string
  ) => DesktopAgentSessionStatusView | null;
}

export function registerRichTextAtServices(
  registry: ServiceRegistry,
  input: RichTextAtServiceRegistrationInput
): IDesktopRichTextAtService {
  const service = new DesktopRichTextAtService({
    tuttidClient: input.tuttidClient,
    appCenterApps: input.appCenterApps,
    getLocale: input.getLocale,
    resolveAgentIconUrl: input.resolveAgentIconUrl,
    userAvatarPlaceholderUrl: input.userAvatarPlaceholderUrl,
    resolveSessionStatusView: input.resolveSessionStatusView
  });
  registry.registerInstance(IDesktopRichTextAtService, service);
  return service;
}
