import type { ReactNode } from "react";
import {
  RichTextMentionServiceProvider,
  useRichTextMentionService
} from "@tutti-os/ui-rich-text/editor";
import type { RichTextMentionService } from "@tutti-os/ui-rich-text/service";

export function AgentGUIMentionServiceBoundary({
  children,
  service
}: {
  children: ReactNode;
  service?: RichTextMentionService;
}): ReactNode {
  const inheritedService = useRichTextMentionService();

  if (!service || service === inheritedService) {
    return children;
  }

  return (
    <RichTextMentionServiceProvider service={service}>
      {children}
    </RichTextMentionServiceProvider>
  );
}
