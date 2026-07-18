import { useMemo, type ReactNode } from "react";
import {
  RichTextMentionServiceProvider,
  useRichTextMentionService
} from "@tutti-os/ui-rich-text/editor";
import type { RichTextMentionService } from "@tutti-os/ui-rich-text/service";
import { composeAgentGUIMentionService } from "./composeAgentGUIMentionService";

export function AgentGUIMentionServiceBoundary({
  children,
  service
}: {
  children: ReactNode;
  service?: RichTextMentionService;
}): ReactNode {
  const inheritedService = useRichTextMentionService();
  const effectiveService = useMemo(
    () =>
      service && inheritedService && service !== inheritedService
        ? composeAgentGUIMentionService({
            inheritedService,
            surfaceService: service
          })
        : service,
    [inheritedService, service]
  );

  if (!effectiveService || effectiveService === inheritedService) {
    return children;
  }

  return (
    <RichTextMentionServiceProvider service={effectiveService}>
      {children}
    </RichTextMentionServiceProvider>
  );
}
