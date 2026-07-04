import { createDecorator } from "@tutti-os/infra/di";
import type { RichTextTriggerProvider } from "@tutti-os/ui-rich-text/types";

export type DesktopRichTextAtCapability =
  | "file"
  | "workspace-app"
  | "workspace-issue"
  | "agent-target"
  | "agent-session"
  | (string & {});

export interface DesktopRichTextTriggerProviderRequest {
  capabilities: readonly DesktopRichTextAtCapability[];
  metadata?: Readonly<Record<string, unknown>>;
  surface: string;
  target: string;
  workspaceId: string;
}

export interface IDesktopRichTextAtService {
  readonly _serviceBrand: undefined;

  getProviders(
    input: DesktopRichTextTriggerProviderRequest
  ): readonly RichTextTriggerProvider[];
}

export const IDesktopRichTextAtService =
  createDecorator<IDesktopRichTextAtService>("desktop-rich-text-at-service");
