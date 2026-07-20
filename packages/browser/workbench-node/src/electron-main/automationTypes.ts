import type { BrowserNodeAutomationTargetMetadata } from "../core/types.ts";
import type { BrowserGuestWebContents } from "./types.ts";

export type BrowserNodeAutomationTool =
  | "click"
  | "close_page"
  | "evaluate_script"
  | "fill"
  | "list_pages"
  | "navigate_page"
  | "new_page"
  | "select_page"
  | "take_screenshot"
  | "take_snapshot";

export interface BrowserNodeAutomationCallInput {
  agentSessionId?: string | null;
  args?: Record<string, unknown>;
  tool: BrowserNodeAutomationTool;
  workspaceId: string;
}

export interface BrowserNodeAutomationToolResult {
  screenshotData?: string;
  text: string;
}

export interface BrowserNodeAutomationTargetSummary extends BrowserNodeAutomationTargetMetadata {
  nodeId: string;
  title: string;
  url: string;
}

export interface BrowserNodeAutomationAuthorizationInput {
  agentSessionId: string | null;
  args: Record<string, unknown>;
  target: BrowserNodeAutomationTargetSummary;
  tool: BrowserNodeAutomationTool;
  workspaceId: string;
}

export type BrowserNodeAutomationAuthorizationResult =
  | { allowed: true }
  | { allowed: false; code: string; message: string };

export interface BrowserNodeAutomationTargetRequest {
  agentSessionId: string | null;
  requestedPageId?: string | null;
  url?: string | null;
  workspaceId: string;
}

export interface BrowserNodeAutomationRegistryOptions {
  authorize?: (
    input: BrowserNodeAutomationAuthorizationInput
  ) =>
    | BrowserNodeAutomationAuthorizationResult
    | Promise<BrowserNodeAutomationAuthorizationResult>;
  closeTarget?: (target: BrowserNodeAutomationTargetSummary) => Promise<void>;
  leaseTtlMs?: number;
  now?: () => number;
  requestTarget?: (
    input: BrowserNodeAutomationTargetRequest
  ) => Promise<string | null>;
  selectTarget?: (target: BrowserNodeAutomationTargetSummary) => Promise<void>;
}

export interface BrowserNodeAutomationTargetRegistry {
  register(
    nodeId: string,
    contents: BrowserGuestWebContents,
    metadata: BrowserNodeAutomationTargetMetadata
  ): void;
  unregister(nodeId: string, contents?: BrowserGuestWebContents | null): void;
  update(nodeId: string, metadata: BrowserNodeAutomationTargetMetadata): void;
}

export interface BrowserNodeAutomationRegistry extends BrowserNodeAutomationTargetRegistry {
  call(
    input: BrowserNodeAutomationCallInput
  ): Promise<BrowserNodeAutomationToolResult>;
  list(input: {
    agentSessionId?: string | null;
    workspaceId: string;
  }): readonly BrowserNodeAutomationTargetSummary[];
  releaseAgent(agentSessionId: string): void;
}
