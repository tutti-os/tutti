import {
  createRichTextMentionService,
  type RichTextMentionInvalidationSelector,
  type RichTextMentionService
} from "@tutti-os/ui-rich-text/service";
import type { IDesktopRichTextAtService } from "../richTextAtService.interface.ts";

export interface DesktopRichTextMentionInvalidationSource {
  debounceMs?: number;
  selector: RichTextMentionInvalidationSelector;
  subscribe(listener: () => void): () => void;
}

export function createDesktopRichTextMentionService(input: {
  invalidationSources?: readonly DesktopRichTextMentionInvalidationSource[];
  richTextAtService: IDesktopRichTextAtService;
  workspaceId: string;
}): RichTextMentionService {
  const service = createRichTextMentionService({
    providers: input.richTextAtService.getProviders({
      capabilities: [
        "file",
        "workspace-app",
        "workspace-issue",
        "agent-target",
        "agent-session"
      ],
      surface: "desktop-workspace-root",
      target: "workspace",
      workspaceId: input.workspaceId
    })
  });
  const sourceDisposers = (input.invalidationSources ?? []).map((source) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = source.subscribe(() => {
      if (!source.debounceMs) {
        service.invalidate(source.selector);
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        service.invalidate(source.selector);
      }, source.debounceMs);
    });
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  });
  let disposed = false;

  return {
    ...service,
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const disposeSource of sourceDisposers) {
        try {
          disposeSource();
        } catch {
          // One host event source must not prevent the remaining cleanup.
        }
      }
      service.dispose();
    }
  };
}
