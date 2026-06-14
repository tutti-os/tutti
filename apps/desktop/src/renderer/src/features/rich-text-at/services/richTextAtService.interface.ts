import { createDecorator } from "@tutti-os/infra/di";
import type { RichTextAtProvider } from "@tutti-os/ui-rich-text/types";

export type DesktopRichTextAtCapability =
  | "workspace-file"
  | "workspace-app"
  | "workspace-issue"
  | "agent-session"
  | (string & {});

export interface DesktopRichTextAtProviderRequest {
  capabilities: readonly DesktopRichTextAtCapability[];
  metadata?: Readonly<Record<string, unknown>>;
  surface: string;
  target: string;
  workspaceId: string;
}

export interface IDesktopRichTextAtService {
  readonly _serviceBrand: undefined;

  getProviders(
    input: DesktopRichTextAtProviderRequest
  ): readonly RichTextAtProvider[];
}

export const IDesktopRichTextAtService =
  createDecorator<IDesktopRichTextAtService>("desktop-rich-text-at-service");
