import type { ReactNode } from "react";
import {
  RichTextMentionServiceProvider,
  useEffectiveRichTextMentionService,
  useRichTextMentionService
} from "@tutti-os/ui-rich-text/editor";
import type { RichTextMentionService } from "@tutti-os/ui-rich-text/service";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";

export function AgentGUIMentionServiceBoundary({
  children,
  legacyProviders,
  service
}: {
  children: ReactNode;
  legacyProviders?: readonly RichTextTriggerProvider[];
  service?: RichTextMentionService;
}): ReactNode {
  const inheritedService = useRichTextMentionService();
  const effectiveService = useEffectiveRichTextMentionService({
    mentionService: service,
    triggerProviders: legacyProviders
  });

  if (!service && !inheritedService && !legacyProviders?.length) {
    return children;
  }

  return effectiveService !== inheritedService ? (
    <RichTextMentionServiceProvider service={effectiveService}>
      {children}
    </RichTextMentionServiceProvider>
  ) : (
    children
  );
}
