import type {
  CanUseTool,
  PermissionMode,
  PermissionResult,
  PermissionUpdate
} from "@anthropic-ai/claude-agent-sdk";
import { isDeepStrictEqual } from "node:util";
import {
  answersFromInteractivePayload,
  stampAskUserQuestionInput
} from "./normalizer.ts";
import type { ClaudeSDKSidecarEventEmitter } from "./protocol.ts";
import type { ProviderTurnPhase } from "./providerTurnAcceptance.ts";
import { stringValue } from "./runtimeValues.ts";
import { SessionPermissionLedger } from "./sessionPermissionLedger.ts";
import {
  approvalOptions,
  effectivePermissionMode,
  exitPlanOptions,
  isAllowOption,
  isExitPlanAllowOption,
  type SidecarSessionSettings
} from "./sessionSettings.ts";

type ClaudeSDKToolPermissionOptions = Parameters<CanUseTool>[2];

export type ToolPermissionOptions = Pick<
  ClaudeSDKToolPermissionOptions,
  "signal"
> &
  Partial<Omit<ClaudeSDKToolPermissionOptions, "signal">>;

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

export type InteractiveDisposition =
  | "pending"
  | "answered"
  | "superseded"
  | "conflict"
  | "unknown";

export type InteractiveSubmitResult = {
  readonly disposition: InteractiveDisposition;
  readonly replayed?: boolean;
};

type TerminalInteraction = {
  readonly disposition: "answered" | "superseded";
  readonly submission?: InteractiveSubmission;
};

const TERMINAL_INTERACTION_CAPACITY = 1024;

export class InteractiveCoordinator {
  private readonly pending = new Map<string, PendingInteraction>();
  private readonly terminal = new Map<string, TerminalInteraction>();
  private readonly terminalOrder: string[] = [];
  private readonly settings: SidecarSessionSettings;
  private readonly resolveTurnId: (options: ToolPermissionOptions) => string;
  private readonly activateSyntheticTurn: () => string;
  private readonly ensureProviderTurnAcceptance: (
    phase: Extract<ProviderTurnPhase, "waiting_approval" | "waiting_input">,
    signal?: AbortSignal
  ) => Promise<void>;
  private readonly emit: ClaudeSDKSidecarEventEmitter;
  private readonly sessionPermissions = new SessionPermissionLedger();

  constructor(options: {
    settings: SidecarSessionSettings;
    resolveTurnId: (permission: ToolPermissionOptions) => string;
    activateSyntheticTurn: () => string;
    ensureProviderTurnAcceptance: (
      phase: Extract<ProviderTurnPhase, "waiting_approval" | "waiting_input">,
      signal?: AbortSignal
    ) => Promise<void>;
    emit: ClaudeSDKSidecarEventEmitter;
  }) {
    this.settings = options.settings;
    this.resolveTurnId = options.resolveTurnId;
    this.activateSyntheticTurn = options.activateSyntheticTurn;
    this.ensureProviderTurnAcceptance = options.ensureProviderTurnAcceptance;
    this.emit = options.emit;
  }

  submit(
    turnId: string,
    requestId: string,
    action: string,
    optionId: string,
    payload: Record<string, unknown>
  ): InteractiveSubmitResult {
    const key = interactionKey(turnId, requestId);
    const submission = { requestId, action, optionId, payload, turnId };
    const previous = this.terminal.get(key);
    if (previous) {
      if (previous.disposition === "superseded") {
        return { disposition: "superseded", replayed: true };
      }
      if (isDeepStrictEqual(previous.submission, submission)) {
        return { disposition: "answered", replayed: true };
      }
      return { disposition: "conflict" };
    }
    const pending = this.pending.get(key);
    if (!pending) {
      return { disposition: "unknown" };
    }
    this.pending.delete(key);
    this.recordTerminal(key, { disposition: "answered", submission });
    pending.resolve(submission);
    return { disposition: "answered", replayed: false };
  }

  disposition(
    turnId: string,
    requestId: string,
    expected?: Omit<InteractiveSubmission, "requestId" | "turnId">
  ): InteractiveSubmitResult {
    const key = interactionKey(turnId, requestId);
    const terminal = this.terminal.get(key);
    if (terminal) {
      if (
        terminal.disposition === "answered" &&
        expected !== undefined &&
        !isDeepStrictEqual(terminal.submission, {
          requestId,
          turnId,
          ...expected
        })
      ) {
        return { disposition: "conflict" };
      }
      return { disposition: terminal.disposition, replayed: true };
    }
    if (this.pending.has(key)) {
      return { disposition: "pending" };
    }
    return { disposition: "unknown" };
  }

  rejectAll(error: Error): void {
    for (const [key, pending] of this.pending) {
      this.pending.delete(key);
      this.recordTerminal(key, { disposition: "superseded" });
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

    const restoredPermissions = this.sessionPermissions.rehydrate(
      callbackOptions.suggestions
    );
    if (restoredPermissions) {
      return {
        behavior: "allow",
        updatedInput: toolInput,
        updatedPermissions: restoredPermissions
      };
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
      if (submission.optionId === "allow_always") {
        this.sessionPermissions.remember(callbackOptions.suggestions);
      }
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
    const stampedInput = stampAskUserQuestionInput(toolInput);
    const submission = await this.request(
      "user_input_requested",
      "AskUserQuestion",
      stampedInput,
      [],
      callbackOptions
    );
    this.emitResolved("user_input_resolved", submission);
    return {
      behavior: "allow",
      updatedInput: {
        questions: stampedInput.questions,
        answers: answersFromInteractivePayload(submission.payload, stampedInput)
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

  private async request(
    eventType: "approval_requested" | "user_input_requested",
    toolName: string,
    toolInput: Record<string, unknown>,
    options: Array<Record<string, unknown>>,
    callbackOptions: ToolPermissionOptions
  ): Promise<InteractiveSubmission> {
    await this.ensureProviderTurnAcceptance(
      eventType === "approval_requested" ? "waiting_approval" : "waiting_input",
      callbackOptions.signal
    );
    const requestId = crypto.randomUUID();
    const toolUseID = callbackOptions.toolUseID || requestId;
    const agentId = stringValue(callbackOptions.agentID);
    const turnId =
      this.resolveTurnId(callbackOptions) || this.activateSyntheticTurn();
    const request = new Promise<InteractiveSubmission>((resolve, reject) => {
      const key = interactionKey(turnId, requestId);
      this.pending.set(key, { turnId, resolve, reject });
      callbackOptions.signal.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(key)) {
            return;
          }
          this.pending.delete(key);
          this.recordTerminal(key, { disposition: "superseded" });
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
        ...(agentId ? { agentId } : {}),
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

  private recordTerminal(key: string, terminal: TerminalInteraction): void {
    if (this.terminal.has(key)) {
      return;
    }
    this.terminal.set(key, terminal);
    this.terminalOrder.push(key);
    while (this.terminalOrder.length > TERMINAL_INTERACTION_CAPACITY) {
      const oldest = this.terminalOrder.shift();
      if (oldest !== undefined) {
        this.terminal.delete(oldest);
      }
    }
  }
}

function interactionKey(turnId: string, requestId: string): string {
  return `${turnId.trim()}\u0000${requestId.trim()}`;
}
