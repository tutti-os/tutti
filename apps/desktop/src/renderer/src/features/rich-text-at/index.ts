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
  createDesktopAgentSessionMentionProvider,
  type CreateDesktopAgentSessionMentionProviderInput,
  type DesktopAgentSessionStatusView
} from "./providers/desktopAgentSessionMentionProvider.ts";
export { createDesktopAgentSessionStatusViewResolver } from "./providers/desktopAgentSessionStatusView.ts";
export {
  createDesktopRichTextMentionService,
  type DesktopRichTextMentionInvalidationSource
} from "./services/internal/createDesktopRichTextMentionService.ts";
