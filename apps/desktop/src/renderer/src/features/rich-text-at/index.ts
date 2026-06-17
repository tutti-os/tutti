export {
  registerRichTextAtServices,
  type RichTextAtServiceRegistrationInput
} from "./services/registerRichTextAtServices";
export {
  IDesktopRichTextAtService,
  type DesktopRichTextAtCapability,
  type DesktopRichTextTriggerProviderRequest
} from "./services/richTextAtService.interface";
export {
  createDesktopWorkspaceAppMentionProvider,
  type CreateDesktopWorkspaceAppMentionProviderInput,
  type DesktopWorkspaceAppMentionItem
} from "./providers/desktopWorkspaceAppMentionProvider.ts";
export {
  createDesktopAgentSessionMentionProvider,
  type CreateDesktopAgentSessionMentionProviderInput,
  type DesktopAgentSessionStatusView
} from "./providers/desktopAgentSessionMentionProvider.ts";
export { createDesktopAgentSessionStatusViewResolver } from "./providers/desktopAgentSessionStatusView.ts";
