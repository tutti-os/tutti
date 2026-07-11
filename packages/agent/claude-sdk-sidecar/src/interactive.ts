import type {
  PermissionMode,
  PermissionResult,
  PermissionUpdate
} from "@anthropic-ai/claude-agent-sdk";
import { answersFromInteractivePayload } from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import { stringValue } from "./runtimeValues.ts";
import {
  approvalOptions,
  effectivePermissionMode,
  exitPlanOptions,
  isAllowOption,
  isExitPlanAllowOption,
  type SidecarSessionSettings
} from "./sessionSettings.ts";

export type ToolPermissionOptions = {
  readonly signal: AbortSignal;
  readonly suggestions?: PermissionUpdate[];
  readonly toolUseID?: string;
};

type InteractiveSubmission = {
  readonly requestId: string;
  readonly action: string;
  readonly optionId: string;
  readonly payload: Record<string, unknown>;
  readonly turnId: string;
};

type PendingInteraction = {
  readonly turnId: string;
  readonly resolve: (value: InteractiveSubmission) => void;
  readonly reject: (error: Error) => void;
};

export class InteractiveCoordinator {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly settings: SidecarSessionSettings;
  private readonly resolveTurnId: (options: ToolPermissionOptions) => string;
  private readonly activateSyntheticTurn: () => string;
  private readonly emit: ClaudeSDKSidecarEventEmitter;

  constructor(options: {
    settings: SidecarSessionSettings;
    resolveTurnId: (permission: ToolPermissionOptions) => string;
    activateSyntheticTurn: () => string;
    emit: ClaudeSDKSidecarEventEmitter;
  }) {
    this.settings = options.settings;
    this.resolveTurnId = options.resolveTurnId;
    this.activateSyntheticTurn = options.activateSyntheticTurn;
    this.emit = options.emit;
  }

  submit(
    requestId: string,
    action: string,
    optionId: string,
    payload: Record<string, unknown>
  ): void {
    const pending = this.pending.get(requestId);
    if (!pending) {
      throw new Error(`interactive request ${requestId} is no longer live`);
    }
    this.pending.delete(requestId);
    pending.resolve({
      requestId,
      action,
      optionId,
      payload,
      turnId: pending.turnId
    });
  }

  rejectAll(error: Error): void {
    for (const [requestId, pending] of this.pending) {
      this.pending.delete(requestId);
      pending.reject(error);
    }
  }

  async handleToolPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    callbackOptions: ToolPermissionOptions
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") {
      return this.handleAskUserQuestion(toolInput, callbackOptions);
    }
    if (toolName === "ExitPlanMode") {
      return this.handleExitPlanMode(toolInput, callbackOptions);
    }
    if (effectivePermissionMode(this.settings) === "bypassPermissions") {
      return { behavior: "allow", updatedInput: toolInput };
    }

    const submission = await this.request(
      "approval_requested",
      toolName,
      toolInput,
      approvalOptions(),
      callbackOptions
    );
    this.emitResolved("approval_resolved", submission);
    if (isAllowOption(submission.optionId)) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        ...(submission.optionId === "allow_always" &&
        callbackOptions.suggestions
          ? { updatedPermissions: [...callbackOptions.suggestions] }
          : {})
      };
    }
    return {
      behavior: "deny",
      message:
        stringValue(submission.payload.denyMessage) ||
        "User refused permission to run tool"
    };
  }

  private async handleAskUserQuestion(
    toolInput: Record<string, unknown>,
    callbackOptions: ToolPermissionOptions
  ): Promise<PermissionResult> {
    const submission = await this.request(
      "user_input_requested",
      "AskUserQuestion",
      toolInput,
      [],
      callbackOptions
    );
    this.emitResolved("user_input_resolved", submission);
    return {
      behavior: "allow",
      updatedInput: {
        questions: toolInput.questions,
        answers: answersFromInteractivePayload(submission.payload, toolInput)
      }
    };
  }

  private async handleExitPlanMode(
    toolInput: Record<string, unknown>,
    callbackOptions: ToolPermissionOptions
  ): Promise<PermissionResult> {
    const submission = await this.request(
      "user_input_requested",
      "ExitPlanMode",
      toolInput,
      exitPlanOptions(),
      callbackOptions
    );
    this.emitResolved("user_input_resolved", submission);
    if (!isExitPlanAllowOption(submission.optionId)) {
      return {
        behavior: "deny",
        message: "User rejected request to exit plan mode."
      };
    }
    return {
      behavior: "allow",
      updatedInput: toolInput,
      updatedPermissions: callbackOptions.suggestions ?? [
        {
          type: "setMode",
          mode: submission.optionId as PermissionMode,
          destination: "session"
        } as PermissionUpdate
      ]
    };
  }

  private request(
    eventType: "approval_requested" | "user_input_requested",
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Array<Record<string, unknown>>,
    callbackOptions: ToolPermissionOptions
  ): Promise<InteractiveSubmission> {
    const requestId = crypto.randomUUID();
    const toolUseID = callbackOptions.toolUseID || requestId;
    const turnId =
      this.resolveTurnId(callbackOptions) || this.activateSyntheticTurn();
    const request = new Promise<InteractiveSubmission>((resolve, reject) => {
      this.pending.set(requestId, { turnId, resolve, reject });
      callbackOptions.signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(requestId)) {
            return;
          }
          this.pending.delete(requestId);
          reject(new Error("Tool use aborted"));
        },
        { once: true }
      );
    });
    this.emit({
      type: eventType,
      payload: {
        turnId,
        requestId,
        toolCallId: toolUseID,
        toolName,
        input: toolInput,
        options,
        toolCall: {
          toolCallId: toolUseID,
          name: toolName,
          title: toolName,
          toolName,
          input: toolInput
        }
      }
    });
    return request;
  }

  private emitResolved(
    eventType: "approval_resolved" | "user_input_resolved",
    submission: InteractiveSubmission
  ): void {
    this.emit({
      type: eventType,
      payload: {
        turnId: submission.turnId,
        requestId: submission.requestId,
        action: submission.action,
        optionId: submission.optionId,
        payload: submission.payload
      }
    });
  }
}
