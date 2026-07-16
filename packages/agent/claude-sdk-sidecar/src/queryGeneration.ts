import type {
  PermissionMode,
  SDKMessage
} from "@anthropic-ai/claude-agent-sdk";
import { AsyncPromptQueue } from "./promptQueue.ts";
import { readSDKMessageUuid } from "./sdkMessages.ts";
import type { PendingFlagSettings } from "./sessionSettings.ts";
import {
  readQueuedTaskNotificationPrompt,
  readUserMessageNotificationText
} from "./taskNotification.ts";
import { stringValue } from "./runtimeValues.ts";

export type ClaudeQueryRuntime = AsyncIterable<SDKMessage> & {
  initializationResult?: () => Promise<unknown>;
  interrupt?: () => Promise<void>;
  setPermissionMode?: (mode: PermissionMode) => Promise<void>;
  setModel?: (model?: string) => Promise<void>;
  applyFlagSettings?: (settings: PendingFlagSettings) => Promise<void>;
  getContextUsage?: () => Promise<unknown>;
  close?: () => void;
};

export class QueryGeneration {
  readonly promptQueue = new AsyncPromptQueue();
  readonly cancelController = new AbortController();
  readonly id: number;
  query: ClaudeQueryRuntime | undefined;
  consumption: Promise<void> | undefined;
  revoked = false;
  private quarantineCanceledTail: boolean;
  private expectedPromptUuid = "";
  private currentPromptObserved = false;
  private canceledTaskTailObserved = false;

  constructor(id: number, quarantineCanceledTail = false) {
    this.id = id;
    this.quarantineCanceledTail = quarantineCanceledTail;
  }

  expectPromptEcho(promptUuid: string): void {
    if (this.quarantineCanceledTail) {
      this.expectedPromptUuid = promptUuid.trim();
    }
  }

  shouldRouteMessage(message: SDKMessage): boolean {
    if (!this.quarantineCanceledTail) {
      return true;
    }
    const raw = message as unknown as Record<string, unknown>;
    const messageType = stringValue(raw.type);
    const parentToolUseId = stringValue(raw.parent_tool_use_id);
    if (this.isCurrentPromptEcho(message, messageType, parentToolUseId)) {
      this.currentPromptObserved = true;
      return true;
    }
    if (isTaskLifecycleTail(message, messageType)) {
      this.canceledTaskTailObserved = true;
      return false;
    }
    if (messageType === "result" && !parentToolUseId) {
      if (this.canceledTaskTailObserved || !this.currentPromptObserved) {
        this.canceledTaskTailObserved = false;
        return false;
      }
      this.clearCanceledTailQuarantine();
      return true;
    }
    if (messageType === "assistant" && !parentToolUseId) {
      this.clearCanceledTailQuarantine();
    }
    return true;
  }

  revoke(): void {
    if (this.revoked) {
      return;
    }
    this.revoked = true;
    this.promptQueue.close();
    this.cancelController.abort();
  }

  closeQuery(): void {
    this.query?.close?.();
  }

  async shutdown(interrupt: boolean): Promise<void> {
    this.revoke();
    let failure: unknown;
    try {
      if (interrupt) {
        await this.query?.interrupt?.();
      }
    } catch (error) {
      failure = error;
    } finally {
      // Revocation fences callbacks while interrupt waits for its SDK ACK.
      // Closing earlier rejects that pending ACK as a transport failure.
      try {
        this.closeQuery();
      } catch (error) {
        failure ??= error;
      }
    }
    await this.consumption;
    if (failure !== undefined) {
      throw failure;
    }
  }

  private isCurrentPromptEcho(
    message: SDKMessage,
    messageType: string,
    parentToolUseId: string
  ): boolean {
    if (messageType !== "user" || parentToolUseId) {
      return false;
    }
    const notificationText = readUserMessageNotificationText(
      message as { message?: { content?: unknown } }
    );
    if (notificationText.includes("<task-notification>")) {
      return false;
    }
    return (
      readSDKMessageUuid(message) === this.expectedPromptUuid ||
      notificationText !== ""
    );
  }

  private clearCanceledTailQuarantine(): void {
    this.quarantineCanceledTail = false;
    this.expectedPromptUuid = "";
    this.currentPromptObserved = false;
    this.canceledTaskTailObserved = false;
  }
}

function isTaskLifecycleTail(
  message: SDKMessage,
  messageType: string
): boolean {
  const raw = message as unknown as Record<string, unknown>;
  if (messageType === "system") {
    return [
      "task_started",
      "task_progress",
      "task_notification",
      "task_updated"
    ].includes(stringValue(raw.subtype));
  }
  if (messageType === "attachment") {
    return readQueuedTaskNotificationPrompt(raw).includes(
      "<task-notification>"
    );
  }
  if (messageType !== "user") {
    return false;
  }
  return readUserMessageNotificationText(
    message as { message?: { content?: unknown } }
  ).includes("<task-notification>");
}
