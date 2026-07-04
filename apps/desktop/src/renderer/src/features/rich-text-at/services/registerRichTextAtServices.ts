import type { ServiceRegistry } from "@tutti-os/infra/di";
import type {
  AgentProviderStatus,
  TuttidClient
} from "@tutti-os/client-tuttid-ts";
import { DesktopRichTextAtService } from "./internal/desktopRichTextAtService";
import { IDesktopRichTextAtService } from "./richTextAtService.interface";
import type { IAgentsService } from "../../workspace-agent/services/agentsService.interface";
import type { DesktopAgentSessionStatusView } from "../providers/desktopAgentSessionMentionProvider";

export interface RichTextAtServiceRegistrationInput {
  agentsService?: IAgentsService;
  tuttidClient: TuttidClient;
  getLocale?: () => string;
  resolveAgentIconUrl?: (provider: string) => string;
  userAvatarPlaceholderUrl?: string;
  resolveSessionStatusView?: (
    status: string
  ) => DesktopAgentSessionStatusView | null;
  agentProviderStatuses?: () => readonly AgentProviderStatus[] | undefined;
}

export function registerRichTextAtServices(
  registry: ServiceRegistry,
  input: RichTextAtServiceRegistrationInput
): IDesktopRichTextAtService {
  const service = new DesktopRichTextAtService({
    agentsService: input.agentsService,
    tuttidClient: input.tuttidClient,
    getLocale: input.getLocale,
    resolveAgentIconUrl: input.resolveAgentIconUrl,
    userAvatarPlaceholderUrl: input.userAvatarPlaceholderUrl,
    resolveSessionStatusView: input.resolveSessionStatusView,
    agentProviderStatuses: input.agentProviderStatuses
  });
  registry.registerInstance(IDesktopRichTextAtService, service);
  return service;
}
