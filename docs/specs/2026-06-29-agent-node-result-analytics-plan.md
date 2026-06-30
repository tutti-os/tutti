# Agent Node Result Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete success/failure analytics for agent setup, session creation, message sending, and runtime activity failures, with local `error_code` enums and `error_message` on every agent analytics event.

**Architecture:** Keep the existing analytics pipeline: renderer reports through `IReporterService`, daemon reports through `Reporter.Track()`. Add one generic node-result event for step-level diagnostics, and augment existing agent events with `errorCode` / `errorMessage` so all agent analytics payloads have the same error fields.

**Tech Stack:** TypeScript renderer analytics reporters, Go `tuttid` reporter event packages, existing DataFinder/Tea reporter pipeline, existing `normalizeTuttidError`, `apierrors.Classify`, and runtime error normalization.

---

## Working Notes

- Current worktree already has unrelated workspace-agent modifications. Do not revert them. Stage and commit only files touched by each task.
- The repo stores current design/plan docs under `docs/specs/`; keep this plan there to match local convention.
- Existing generated OpenAPI contracts do not need to change; the analytics payload is schemaless under `params`.
- Existing business funnel events stay in place. `agent.node_result` is additive.

## File Map

Create:

- `apps/desktop/src/renderer/src/features/analytics/reporters/agent-error-fields.ts`
  - TypeScript source of truth for agent analytics error fields and helpers.
- `apps/desktop/src/renderer/src/features/analytics/reporters/agent-node-result/agentNodeResultReporter.ts`
  - Renderer reporter for `agent.node_result`.
- `apps/desktop/src/renderer/src/features/analytics/reporters/agent-node-result/types.ts`
  - Renderer type contract for node-result params.
- `apps/desktop/src/renderer/src/features/analytics/reporters/agent-node-result/index.ts`
  - Reporter export.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentNodeResultAnalytics.ts`
  - Renderer tracking helper for step success/failure, error normalization, and duration.
- `services/tuttid/service/reporter/events/agent/node_result/event.go`
  - Daemon reporter package for `agent.node_result`.
- `services/tuttid/service/reporter/events/agent/error_codes.go`
  - Go constants for agent analytics error codes.
- `services/tuttid/service/reporter/events/agent/node_result_params.go`
  - Go helper for `agent.node_result` params.

Modify:

- `apps/desktop/src/renderer/src/features/analytics/reporters/reporterCompleteness.test.ts`
  - Add `agent.node_result`.
- Existing renderer agent reporter `types.ts` files under `apps/desktop/src/renderer/src/features/analytics/reporters/agent-*` and `error-agent-session-failed/types.ts`
  - Include `errorCode` and `errorMessage`.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentMessageSentAnalytics.ts`
  - Emit success error fields on `agent.message_sent`.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentSessionStartedAnalytics.ts`
  - Emit success error fields on `agent.session_started`.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts`
  - Report provider setup node results.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`
  - Report activation/send high-level node results.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
  - Report service send/activate/reconcile/event-stream node results.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts`
  - Report HTTP create/send request node results.
- `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/createDesktopAgentHostAgentSessionsApi.ts`
  - Add `errorMessage` to `error.agent_session_failed`.
- `services/tuttid/service/reporter/events/events_completeness_test.go`
  - Add `agent.node_result`.
- `services/tuttid/service/agentstatus/service.go`
  - Report daemon install action node results.
- `services/tuttid/service/agentstatus/installer.go`
  - Report install cli/adapter step node results.
- `services/tuttid/service/agent/service.go`
  - Report create/send runtime node results.
- `docs/architecture/analytics-tracking.md`
  - Document `agent.node_result` and error fields.

## Task 1: Renderer Error Field Contract

**Files:**

- Create: `apps/desktop/src/renderer/src/features/analytics/reporters/agent-error-fields.ts`
- Modify: `apps/desktop/src/renderer/src/features/analytics/reporters/agent-message-sent/types.ts`
- Modify: `apps/desktop/src/renderer/src/features/analytics/reporters/agent-session-started/types.ts`
- Modify: `apps/desktop/src/renderer/src/features/analytics/reporters/error-agent-session-failed/types.ts`
- Test: existing reporter tests plus TypeScript typecheck

- [ ] **Step 1: Add the shared renderer error enum and helpers**

Create `apps/desktop/src/renderer/src/features/analytics/reporters/agent-error-fields.ts`:

```ts
import { normalizeTuttidError } from "@tutti-os/client-tuttid-ts";

export const AgentAnalyticsErrorCode = {
  None: "agent_error_none",
  ProviderStatusFailed: "agent_provider_status_failed",
  InstallFailed: "agent_install_failed",
  InstallTimeout: "agent_install_timeout",
  InstallCanceled: "agent_install_canceled",
  InstallProbeFailed: "agent_install_probe_failed",
  LoginLaunchFailed: "agent_login_launch_failed",
  LoginTimeout: "agent_login_timeout",
  LoginAuthFailed: "agent_login_auth_failed",
  SessionCreateFailed: "agent_session_create_failed",
  SessionResumeFailed: "agent_session_resume_failed",
  RuntimePrepareFailed: "agent_runtime_prepare_failed",
  RuntimeStartFailed: "agent_runtime_start_failed",
  RuntimeExecFailed: "agent_runtime_exec_failed",
  RuntimeNetworkDisconnected: "agent_runtime_network_disconnected",
  RuntimeProcessExited: "agent_runtime_process_exited",
  RuntimeCanceled: "agent_runtime_canceled",
  PromptNormalizeFailed: "agent_prompt_normalize_failed",
  PromptValidateFailed: "agent_prompt_validate_failed",
  PromptPrepareFailed: "agent_prompt_prepare_failed",
  ActivityEventStreamFailed: "agent_activity_event_stream_failed",
  ActivityReconcileFailed: "agent_activity_reconcile_failed",
  Unknown: "agent_unknown_error"
} as const;

export type AgentAnalyticsErrorCode =
  (typeof AgentAnalyticsErrorCode)[keyof typeof AgentAnalyticsErrorCode];

export interface AgentAnalyticsErrorFields {
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
}

export const agentAnalyticsSuccessFields = {
  errorCode: AgentAnalyticsErrorCode.None,
  errorMessage: ""
} satisfies AgentAnalyticsErrorFields;

export function agentAnalyticsErrorFields(
  error: unknown,
  fallbackCode: AgentAnalyticsErrorCode
): AgentAnalyticsErrorFields {
  const normalized = normalizeTuttidError(error);
  return {
    errorCode: mapTuttidErrorCode(
      normalized?.reason ?? normalized?.code,
      fallbackCode
    ),
    errorMessage: errorMessageOf(error)
  };
}

function mapTuttidErrorCode(
  code: string | null | undefined,
  fallbackCode: AgentAnalyticsErrorCode
): AgentAnalyticsErrorCode {
  const normalized = code?.trim();
  if (!normalized) {
    return fallbackCode;
  }
  if (
    normalized === "auth_required" ||
    normalized === "authentication_failed"
  ) {
    return AgentAnalyticsErrorCode.LoginAuthFailed;
  }
  if (normalized === "agent_provider_unavailable") {
    return AgentAnalyticsErrorCode.ProviderStatusFailed;
  }
  if (normalized === "acp_adapter_launch_failed") {
    return AgentAnalyticsErrorCode.RuntimeStartFailed;
  }
  return fallbackCode;
}

export function errorMessageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  const text = String(error).trim();
  return text || "Unknown agent error";
}
```

- [ ] **Step 2: Extend existing agent event type contracts**

For each existing agent analytics type, add:

```ts
import type { AgentAnalyticsErrorFields } from "../agent-error-fields.ts";
```

Then extend the params interface:

```ts
export interface AgentMessageSentParams
  extends AnalyticsReporterParams, AgentAnalyticsErrorFields {
  agentSessionId: string;
  conversationIndex: number;
  hasFileMention: boolean;
  hasSlashCommand: boolean;
  isQueued: boolean;
  provider: string;
}
```

Apply the same pattern to:

- `agent-session-started/types.ts`
- `agent-message-stopped/types.ts`
- `agent-provider-login-initiated/types.ts`
- `agent-provider-login-result/types.ts`
- `agent-provider-ready/types.ts`
- `agent-chat-ready/types.ts`
- `agent-env-detected/types.ts`
- `agent-env-issue-reported/types.ts`
- `agent-conversation-pinned/types.ts`
- `agent-conversation-unpinned/types.ts`
- `agent-workspace-file-referenced/types.ts`
- `agent-settings-*/types.ts`
- `error-agent-session-failed/types.ts`

For `error-agent-session-failed/types.ts`, replace the existing nullable `errorCode` type with the enum-backed fields:

```ts
import type {
  AgentAnalyticsErrorCode,
  AgentAnalyticsErrorFields
} from "../agent-error-fields.ts";

export interface ErrorAgentSessionFailedParams
  extends AnalyticsReporterParams, AgentAnalyticsErrorFields {
  agentSessionId: string;
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
  isRetryable: boolean;
  provider: string;
}
```

- [ ] **Step 3: Run typecheck to see all callers that need success fields**

Run:

```sh
pnpm --filter @tutti-os/desktop typecheck
```

Expected: FAIL with TypeScript errors at agent reporter call sites that do not pass `errorCode` and `errorMessage`.

- [ ] **Step 4: Add success fields to existing success trackers**

In `agentMessageSentAnalytics.ts` and `agentSessionStartedAnalytics.ts`, import:

```ts
import { agentAnalyticsSuccessFields } from "../../../analytics/reporters/agent-error-fields.ts";
```

Add the spread inside reporter params:

```ts
await new AgentMessageSentReporter(
  {
    ...agentAnalyticsSuccessFields,
    agentSessionId: message.agentSessionId,
    conversationIndex,
    hasFileMention: hasAgentMessageFileMention(message.prompt),
    hasSlashCommand: hasAgentMessageSlashCommand(message.prompt),
    isQueued: message.isQueued === true,
    provider: message.provider
  },
  {
    reporterService: createOptionalReporterService(input.reporterService),
    now: input.reporterNow
  }
).report();
```

Do the same for `AgentSessionStartedReporter` params.

- [ ] **Step 5: Add success fields to remaining existing agent reporter callers**

For all TypeScript errors from Step 3, add `...agentAnalyticsSuccessFields` to success event params.

For `ErrorAgentSessionFailedReporter`, use:

```ts
import {
  AgentAnalyticsErrorCode,
  errorMessageOf
} from "../../../analytics/reporters/agent-error-fields.ts";

await new ErrorAgentSessionFailedReporter(
  {
    agentSessionId: activation.session.agentSessionId,
    errorCode: AgentAnalyticsErrorCode.SessionCreateFailed,
    errorMessage:
      activation.error?.message?.trim() || errorMessageOf(activation.error),
    isRetryable: false,
    provider: activation.session.provider
  },
  {
    reporterService: createOptionalReporterService(reporterService),
    now: reporterNow
  }
).report();
```

- [ ] **Step 6: Run typecheck until it passes**

Run:

```sh
pnpm --filter @tutti-os/desktop typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 1**

```sh
git add apps/desktop/src/renderer/src/features/analytics/reporters apps/desktop/src/renderer/src/features/workspace-agent/services
git commit -m "feat(agent): require error fields on analytics events"
```

## Task 2: Renderer `agent.node_result` Reporter

**Files:**

- Create: `apps/desktop/src/renderer/src/features/analytics/reporters/agent-node-result/*`
- Modify: `apps/desktop/src/renderer/src/features/analytics/reporters/reporterCompleteness.test.ts`
- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentNodeResultAnalytics.ts`
- Test: `pnpm --filter @tutti-os/desktop test -- reporterCompleteness`

- [ ] **Step 1: Add the reporter type and class**

Create `agent-node-result/types.ts`:

```ts
import type { AnalyticsReporterParams } from "../baseReporter.ts";
import type {
  AgentAnalyticsErrorCode,
  AgentAnalyticsErrorFields
} from "../agent-error-fields.ts";

export type AgentAnalyticsFlow =
  | "provider_setup"
  | "session_create"
  | "message_send"
  | "runtime_activity";

export type AgentAnalyticsNode =
  | "provider_status_request"
  | "provider_status_detect"
  | "install_action_requested"
  | "install_daemon_action"
  | "install_cli"
  | "install_adapter"
  | "install_post_probe"
  | "login_action_requested"
  | "login_terminal_launch"
  | "login_auth_poll"
  | "login_ready_detected"
  | "activate_session"
  | "create_session_request"
  | "send_input_request"
  | "content_normalized"
  | "provider_runtime_checked"
  | "model_validated"
  | "cwd_resolved"
  | "runtime_prepared"
  | "runtime_started"
  | "runtime_session_ready"
  | "prompt_validated"
  | "prompt_prepared"
  | "runtime_exec"
  | "session_refreshed"
  | "session_started_reported"
  | "message_sent_reported"
  | "runtime_event_received"
  | "activity_projection_state"
  | "activity_projection_messages"
  | "activity_event_stream"
  | "activity_reconcile_state"
  | "activity_reconcile_messages"
  | "agent_gui_refresh";

export interface AgentNodeResultParams
  extends AnalyticsReporterParams, AgentAnalyticsErrorFields {
  agentSessionId: string | null;
  durationMs: number | null;
  flow: AgentAnalyticsFlow;
  node: AgentAnalyticsNode;
  provider: string;
  status: "success" | "failure";
  errorCode: AgentAnalyticsErrorCode;
  errorMessage: string;
}
```

Create `agent-node-result/agentNodeResultReporter.ts`:

```ts
import {
  BaseAnalyticsReporter,
  type AnalyticsReporterDependencies
} from "../baseReporter.ts";
import type { AgentNodeResultParams } from "./types.ts";

export class AgentNodeResultReporter extends BaseAnalyticsReporter<AgentNodeResultParams> {
  protected readonly eventName = "agent.node_result";

  constructor(
    params: AgentNodeResultParams,
    dependencies: AnalyticsReporterDependencies
  ) {
    super(params, dependencies);
  }
}
```

Create `agent-node-result/index.ts`:

```ts
export { AgentNodeResultReporter } from "./agentNodeResultReporter.ts";
export type {
  AgentAnalyticsFlow,
  AgentAnalyticsNode,
  AgentNodeResultParams
} from "./types.ts";
```

- [ ] **Step 2: Add the event to completeness test**

In `reporterCompleteness.test.ts`, add:

```ts
"agent.node_result",
```

after the existing `agent.env_issue_reported` entry.

- [ ] **Step 3: Add the workspace-agent tracking helper**

Create `agentNodeResultAnalytics.ts`:

```ts
import type { IReporterService } from "../../../analytics/services/reporterService.interface.ts";
import {
  AgentAnalyticsErrorCode,
  agentAnalyticsErrorFields,
  agentAnalyticsSuccessFields,
  type AgentAnalyticsErrorFields
} from "../../../analytics/reporters/agent-error-fields.ts";
import { AgentNodeResultReporter } from "../../../analytics/reporters/agent-node-result/agentNodeResultReporter.ts";
import type {
  AgentAnalyticsFlow,
  AgentAnalyticsNode
} from "../../../analytics/reporters/agent-node-result/types.ts";
import { createOptionalReporterService } from "./agentMessageSentAnalytics.ts";

export interface AgentNodeResultTracker {
  failure(
    input: AgentNodeResultBaseInput & {
      error: unknown;
      fallbackCode: AgentAnalyticsErrorCode;
    }
  ): Promise<void>;
  success(input: AgentNodeResultBaseInput): Promise<void>;
}

export interface AgentNodeResultBaseInput {
  agentSessionId?: string | null;
  durationMs?: number | null;
  flow: AgentAnalyticsFlow;
  node: AgentAnalyticsNode;
  provider?: string | null;
}

export function createAgentNodeResultTracker(input: {
  reporterNow?: () => number;
  reporterService?: Pick<IReporterService, "trackEvents">;
}): AgentNodeResultTracker {
  const reporterService = createOptionalReporterService(input.reporterService);
  return {
    failure(event) {
      return reportNodeResult({
        ...event,
        fields: agentAnalyticsErrorFields(event.error, event.fallbackCode),
        reporterNow: input.reporterNow,
        reporterService,
        status: "failure"
      });
    },
    success(event) {
      return reportNodeResult({
        ...event,
        fields: agentAnalyticsSuccessFields,
        reporterNow: input.reporterNow,
        reporterService,
        status: "success"
      });
    }
  };
}

async function reportNodeResult(
  input: AgentNodeResultBaseInput & {
    fields: AgentAnalyticsErrorFields;
    reporterNow?: () => number;
    reporterService: Pick<IReporterService, "trackEvents">;
    status: "success" | "failure";
  }
): Promise<void> {
  try {
    await new AgentNodeResultReporter(
      {
        agentSessionId: input.agentSessionId?.trim() || null,
        durationMs: input.durationMs ?? null,
        flow: input.flow,
        node: input.node,
        provider: input.provider?.trim() || "unknown",
        status: input.status,
        ...input.fields
      },
      {
        reporterService: input.reporterService,
        now: input.reporterNow
      }
    ).report();
  } catch {
    // Analytics must not affect agent flows.
  }
}
```

- [ ] **Step 4: Run reporter completeness test**

Run:

```sh
pnpm --filter @tutti-os/desktop test -- reporterCompleteness
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```sh
git add apps/desktop/src/renderer/src/features/analytics/reporters apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentNodeResultAnalytics.ts
git commit -m "feat(agent): add node result analytics reporter"
```

## Task 3: Provider Setup Node Results

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.test.ts`

- [ ] **Step 1: Add tests for install action success and failure node results**

In `desktopAgentProviderStatusService.test.ts`, add a test where `runAgentProviderAction` returns completed:

```ts
test("provider status service reports install node success", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const service = createService({
    reporterNow: () => 1749124800000,
    reporterService: {
      async trackEvents(events) {
        reporterCalls.push(events);
      }
    },
    tuttidClient: createTuttidClient({
      async runAgentProviderAction() {
        return {
          actionId: "install",
          completedAt: "2026-06-29T00:00:00.000Z",
          provider: "codex",
          status: "completed"
        };
      }
    })
  });

  await service.ensureLoaded({ providers: ["codex"] });
  await service.runAction("codex", "install");

  assert.equal(
    reporterCalls
      .flat()
      .some(
        (event) =>
          event.name === "agent.node_result" &&
          event.params.flow === "provider_setup" &&
          event.params.node === "install_daemon_action" &&
          event.params.status === "success" &&
          event.params.error_code === "agent_error_none" &&
          event.params.error_message === ""
      ),
    true
  );
});
```

Add a second test where `runAgentProviderAction` returns failed with `reasonCode` and `message`; assert `status === "failure"`, `error_code === "agent_install_failed"`, and `error_message` equals the returned message.

- [ ] **Step 2: Wire the tracker into the service constructor**

Import:

```ts
import { AgentAnalyticsErrorCode } from "../../../analytics/reporters/agent-error-fields.ts";
import { createAgentNodeResultTracker } from "./agentNodeResultAnalytics.ts";
```

Inside `runAction`, create a tracker:

```ts
const nodeResults = createAgentNodeResultTracker({
  reporterNow: this.dependencies.reporterNow,
  reporterService: this.dependencies.reporterService
});
```

- [ ] **Step 3: Report install action requested and daemon action result**

At the beginning of `runAction`, for install/login:

```ts
await nodeResults.success({
  flow: "provider_setup",
  node:
    actionId === "install"
      ? "install_action_requested"
      : "login_action_requested",
  provider
});
```

For install success after `runInstalledProviderAction`:

```ts
await nodeResults.success({
  flow: "provider_setup",
  node: "install_daemon_action",
  provider
});
```

For install failure in the catch block:

```ts
await nodeResults.failure({
  error,
  fallbackCode: AgentAnalyticsErrorCode.InstallFailed,
  flow: "provider_setup",
  node: "install_daemon_action",
  provider
});
```

- [ ] **Step 4: Report login terminal launch success/failure and auth ready**

After `terminalCommandRunner.runTerminalCommand` resolves for login:

```ts
await nodeResults.success({
  flow: "provider_setup",
  node: "login_terminal_launch",
  provider
});
```

Inside login catch:

```ts
await nodeResults.failure({
  error,
  fallbackCode: AgentAnalyticsErrorCode.LoginLaunchFailed,
  flow: "provider_setup",
  node: "login_terminal_launch",
  provider
});
```

Inside `reportCompletedLoginResults`, after success:

```ts
await nodeResults.success({
  flow: "provider_setup",
  node: "login_ready_detected",
  provider: status.provider
});
```

- [ ] **Step 5: Run focused tests**

Run:

```sh
pnpm --filter @tutti-os/desktop test -- desktopAgentProviderStatusService
```

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```sh
git add apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.ts apps/desktop/src/renderer/src/features/workspace-agent/services/internal/desktopAgentProviderStatusService.test.ts
git commit -m "feat(agent): track provider setup node results"
```

## Task 4: Renderer Session Create and Send Node Results

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts`
- Modify tests in matching `*.test.ts` files.

- [ ] **Step 1: Add failing tests for sendInput failure**

In `createDesktopAgentActivityRuntime.test.ts`, add a test where `workspaceAgentActivityService.sendInput` rejects:

```ts
test("activity runtime reports send failure node result", async () => {
  const reporterCalls: ReporterEventInput[][] = [];
  const runtime = createDesktopAgentActivityRuntime(
    createWorkspaceAgentActivityService({
      async sendInput() {
        throw new Error("network disconnected");
      }
    }),
    {
      reporterNow: () => 1749124800000,
      reporterService: {
        async trackEvents(events) {
          reporterCalls.push(events);
        }
      }
    }
  );

  await assert.rejects(
    runtime.sendInput({
      agentSessionId: "session-1",
      content: [{ type: "text", text: "hello" }],
      workspaceId: "workspace-1"
    }),
    /network disconnected/
  );

  assert.equal(
    reporterCalls
      .flat()
      .some(
        (event) =>
          event.name === "agent.node_result" &&
          event.params.flow === "message_send" &&
          event.params.node === "send_input_request" &&
          event.params.status === "failure" &&
          event.params.error_message === "network disconnected"
      ),
    true
  );
});
```

- [ ] **Step 2: Report activateSession success/failure in runtime wrapper**

In `createDesktopAgentActivityRuntime.ts`, create `nodeResults` next to existing trackers.

Wrap `activateSession`:

```ts
const startedAt = Date.now();
try {
  const activation = await workspaceAgentActivityService.activateSession(input);
  await nodeResults.success({
    agentSessionId: activation.session.agentSessionId,
    durationMs: Date.now() - startedAt,
    flow: "session_create",
    node: "activate_session",
    provider: activation.session.provider
  });
  return activation;
} catch (error) {
  await nodeResults.failure({
    agentSessionId: input.agentSessionId,
    durationMs: Date.now() - startedAt,
    error,
    fallbackCode: AgentAnalyticsErrorCode.SessionCreateFailed,
    flow: "session_create",
    node: "activate_session",
    provider: resolveDesktopAgentGUIProvider(input.provider)
  });
  throw error;
}
```

- [ ] **Step 3: Report sendInput success/failure in runtime wrapper**

Wrap `sendInput` in the same file:

```ts
const startedAt = Date.now();
try {
  const result = await workspaceAgentActivityService.sendInput(input);
  await nodeResults.success({
    agentSessionId: result.session.agentSessionId,
    durationMs: Date.now() - startedAt,
    flow: "message_send",
    node: "send_input_request",
    provider: result.session.provider
  });
  return result;
} catch (error) {
  await nodeResults.failure({
    agentSessionId: input.agentSessionId,
    durationMs: Date.now() - startedAt,
    error,
    fallbackCode: AgentAnalyticsErrorCode.RuntimeExecFailed,
    flow: "message_send",
    node: "send_input_request",
    provider: null
  });
  throw error;
}
```

Keep existing `agent.message_sent` success reporting after the service call resolves.

- [ ] **Step 4: Add adapter-level HTTP request node results**

In `desktopAgentActivityAdapter.ts`, create a tracker in `createDesktopAgentActivityAdapter` by extending `CreateDesktopAgentActivityAdapterInput` with optional `reporterNow` and `reporterService`. Pass them from `WorkspaceAgentActivityService` dependencies if needed.

Report:

```ts
flow: "session_create", node: "create_session_request"
flow: "message_send", node: "send_input_request"
```

Use success after the HTTP call resolves and failure in `catch`.

- [ ] **Step 5: Run focused renderer tests**

Run:

```sh
pnpm --filter @tutti-os/desktop test -- createDesktopAgentActivityRuntime desktopAgentActivityAdapter workspaceAgentActivityService
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```sh
git add apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.ts apps/desktop/src/renderer/src/features/workspace-agent/services/createDesktopAgentActivityRuntime.test.ts apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.ts apps/desktop/src/renderer/src/features/workspace-agent/services/desktopAgentActivityAdapter.test.ts apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts
git commit -m "feat(agent): track session and message node results"
```

## Task 5: Daemon Node Result Event and Install Runtime Reporting

**Files:**

- Create: `services/tuttid/service/reporter/events/agent/error_codes.go`
- Create: `services/tuttid/service/reporter/events/agent/node_result/event.go`
- Create: `services/tuttid/service/reporter/events/agent/node_result_params.go`
- Modify: `services/tuttid/service/reporter/events/events_completeness_test.go`
- Modify: `services/tuttid/service/agentstatus/service.go`
- Modify: `services/tuttid/service/agentstatus/installer.go`
- Test: `services/tuttid/service/agentstatus/service_test.go`

- [ ] **Step 1: Add Go constants and reporter package**

Create `error_codes.go`:

```go
package agent

const (
	ErrorNone                    = "agent_error_none"
	ErrorInstallFailed           = "agent_install_failed"
	ErrorInstallTimeout          = "agent_install_timeout"
	ErrorInstallCanceled         = "agent_install_canceled"
	ErrorInstallProbeFailed      = "agent_install_probe_failed"
	ErrorRuntimeStartFailed      = "agent_runtime_start_failed"
	ErrorRuntimeExecFailed       = "agent_runtime_exec_failed"
	ErrorRuntimeProcessExited    = "agent_runtime_process_exited"
	ErrorRuntimeNetworkDisconnected = "agent_runtime_network_disconnected"
	ErrorPromptNormalizeFailed   = "agent_prompt_normalize_failed"
	ErrorPromptValidateFailed    = "agent_prompt_validate_failed"
	ErrorPromptPrepareFailed     = "agent_prompt_prepare_failed"
	ErrorActivityReconcileFailed = "agent_activity_reconcile_failed"
	ErrorUnknown                 = "agent_unknown_error"
)
```

Create `node_result/event.go`:

```go
package node_result

import (
	"context"

	reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
	reporterevents "github.com/tutti-os/tutti/services/tuttid/service/reporter/events"
)

type Params map[string]any

func Track(ctx context.Context, reporter reporterservice.Reporter, params Params) {
	reporterevents.Track(ctx, reporter, "agent.node_result", map[string]any(params))
}
```

Create `node_result_params.go`:

```go
package agent

func NodeResultParams(flow string, node string, status string, provider string, agentSessionID string, durationMS int64, errorCode string, errorMessage string) map[string]any {
	if errorCode == "" {
		errorCode = ErrorNone
	}
	return map[string]any{
		"flow":             flow,
		"node":             node,
		"status":           status,
		"provider":         provider,
		"agent_session_id": agentSessionID,
		"duration_ms":      durationMS,
		"error_code":       errorCode,
		"error_message":    errorMessage,
	}
}
```

- [ ] **Step 2: Add the event to server completeness test**

Add `"agent.node_result"` to `expectedAnalyticsEvents` after `agent.env_issue_reported`.

- [ ] **Step 3: Inject reporter into agentstatus service**

Add a field to `agentstatus.Service`:

```go
Reporter reporterservice.Reporter
```

Import:

```go
reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
agentreporter "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent"
node_result "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/node_result"
```

At install action success:

```go
node_result.Track(ctx, s.Reporter, agentreporter.NodeResultParams(
	"provider_setup",
	"install_daemon_action",
	"success",
	spec.Provider,
	"",
	time.Since(startedAt).Milliseconds(),
	agentreporter.ErrorNone,
	"",
))
```

At install action failure:

```go
node_result.Track(ctx, s.Reporter, agentreporter.NodeResultParams(
	"provider_setup",
	"install_daemon_action",
	"failure",
	spec.Provider,
	"",
	time.Since(startedAt).Milliseconds(),
	errorCodeForInstallResult(result),
	result.Message,
))
```

Add helper:

```go
func errorCodeForInstallResult(result RunActionResult) string {
	switch result.ReasonCode {
	case "install_timed_out":
		return agentreporter.ErrorInstallTimeout
	case "install_canceled":
		return agentreporter.ErrorInstallCanceled
	case "post_install_probe_failed":
		return agentreporter.ErrorInstallProbeFailed
	default:
		return agentreporter.ErrorInstallFailed
	}
}
```

- [ ] **Step 4: Report install cli/adapter steps in installer.go**

In `installMissingProviderRuntime`, record `startedAt := time.Now()` before `executeInstaller`.

After each successful command:

```go
node_result.Track(ctx, s.Reporter, agentreporter.NodeResultParams(
	"provider_setup",
	"install_"+installTarget,
	"success",
	spec.Provider,
	"",
	time.Since(startedAt).Milliseconds(),
	agentreporter.ErrorNone,
	"",
))
```

On command error or non-zero exit:

```go
node_result.Track(ctx, s.Reporter, agentreporter.NodeResultParams(
	"provider_setup",
	"install_"+installTarget,
	"failure",
	spec.Provider,
	"",
	time.Since(startedAt).Milliseconds(),
	agentreporter.ErrorInstallFailed,
	firstNonBlank(result.Stderr, result.Stdout, errString(err), "Install command failed"),
))
```

Add:

```go
func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}
```

- [ ] **Step 5: Run Go tests**

Run:

```sh
go test ./services/tuttid/service/reporter/events ./services/tuttid/service/agentstatus
```

Expected: PASS.

- [ ] **Step 6: Commit Task 5**

```sh
git add services/tuttid/service/reporter/events services/tuttid/service/agentstatus
git commit -m "feat(agent): track daemon install node results"
```

## Task 6: Daemon Create/Send Runtime Node Results

**Files:**

- Modify: `services/tuttid/service/agent/service.go`
- Test: `services/tuttid/service/agent/service_test.go`

- [ ] **Step 1: Add reporter dependency to agent Service**

Modify `Service` struct in `service.go` to include:

```go
Reporter reporterservice.Reporter
```

Import reporter packages:

```go
reporterservice "github.com/tutti-os/tutti/services/tuttid/service/reporter"
agentreporter "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent"
node_result "github.com/tutti-os/tutti/services/tuttid/service/reporter/events/agent/node_result"
```

- [ ] **Step 2: Add local helper methods**

Add near the bottom of `service.go`:

```go
func (s *Service) trackNodeResult(ctx context.Context, flow string, node string, status string, provider string, agentSessionID string, startedAt time.Time, errorCode string, errorMessage string) {
	node_result.Track(ctx, s.Reporter, agentreporter.NodeResultParams(
		flow,
		node,
		status,
		provider,
		agentSessionID,
		time.Since(startedAt).Milliseconds(),
		errorCode,
		errorMessage,
	))
}

func (s *Service) trackNodeSuccess(ctx context.Context, flow string, node string, provider string, agentSessionID string, startedAt time.Time) {
	s.trackNodeResult(ctx, flow, node, "success", provider, agentSessionID, startedAt, agentreporter.ErrorNone, "")
}

func (s *Service) trackNodeFailure(ctx context.Context, flow string, node string, provider string, agentSessionID string, startedAt time.Time, errorCode string, err error) {
	message := "Unknown agent error"
	if err != nil && strings.TrimSpace(err.Error()) != "" {
		message = strings.TrimSpace(err.Error())
	}
	s.trackNodeResult(ctx, flow, node, "failure", provider, agentSessionID, startedAt, errorCode, message)
}
```

- [ ] **Step 3: Instrument Create**

Wrap each step in `Create`:

```go
startedAt := time.Now()
normalizedContent, _, err = normalizePromptContent(input.InitialContent)
if err != nil {
	s.trackNodeFailure(ctx, "session_create", "content_normalized", provider, input.AgentSessionID, startedAt, agentreporter.ErrorPromptNormalizeFailed, err)
	return Session{}, err
}
s.trackNodeSuccess(ctx, "session_create", "content_normalized", provider, input.AgentSessionID, startedAt)
```

Repeat this pattern for:

- `ensureProviderRuntimeInstalled` -> node `provider_runtime_checked`, fallback `ErrorRuntimeStartFailed`
- `validateComposerModelForCreate` -> node `model_validated`, fallback `ErrorUnknown`
- `resolveCwd` -> node `cwd_resolved`, fallback `ErrorUnknown`
- `prepareRuntime` -> node `runtime_prepared`, fallback `ErrorRuntimeStartFailed`
- `controller().Start` -> node `runtime_started`, fallback `ErrorRuntimeStartFailed`
- `validatePromptContentForExec` -> node `prompt_validated`, fallback `ErrorPromptValidateFailed`
- `prepareNormalizedPromptContentForExec` -> node `prompt_prepared`, fallback `ErrorPromptPrepareFailed`
- `controller().Exec` -> node `runtime_exec`, fallback `ErrorRuntimeExecFailed`

- [ ] **Step 4: Instrument SendInput**

In `SendInput`, wrap:

- `ensureRuntimeSession` -> `runtime_session_ready`
- `normalizePromptContent` -> `content_normalized`
- `validatePromptContentForExec` -> `prompt_validated`
- `prepareNormalizedPromptContentForExec` -> `prompt_prepared`
- `controller().Exec` -> `runtime_exec`
- `s.Get` -> `session_refreshed`

Use `flow = "message_send"` and the same error code mapping as Create.

- [ ] **Step 5: Add Go tests for runtime exec failure**

In `service_test.go`, add a fake reporter that records events:

```go
type recordingReporter struct {
	events []reporter.Event
}

func (r *recordingReporter) Track(_ context.Context, events ...reporter.Event) {
	r.events = append(r.events, events...)
}

func (r *recordingReporter) Close() error { return nil }
```

Create a service whose fake runtime returns an error from `Exec`, call `SendInput`, and assert an `agent.node_result` event with:

```go
params["flow"] == "message_send"
params["node"] == "runtime_exec"
params["status"] == "failure"
params["error_code"] == "agent_runtime_exec_failed"
params["error_message"] != ""
```

- [ ] **Step 6: Run Go tests**

Run:

```sh
go test ./services/tuttid/service/agent
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6**

```sh
git add services/tuttid/service/agent
git commit -m "feat(agent): track runtime create and send node results"
```

## Task 7: Activity Runtime Failure Reporting

**Files:**

- Modify: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts`
- Test: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts`

- [ ] **Step 1: Add tests for event stream connect failure**

Add a test where `eventStreamClient.connect()` rejects with `new Error("socket closed")`. Assert `agent.node_result` is emitted with:

```ts
flow: "runtime_activity";
node: "activity_event_stream";
status: "failure";
error_code: "agent_activity_event_stream_failed";
error_message: "socket closed";
```

- [ ] **Step 2: Add tests for reconcile failure**

Add a test where `reconcileAgentSessionMessages` path rejects. Assert `agent.node_result` with:

```ts
flow: "runtime_activity";
node: "activity_reconcile_messages";
status: "failure";
error_code: "agent_activity_reconcile_failed";
```

- [ ] **Step 3: Inject reporter dependencies into WorkspaceAgentActivityService**

Extend `WorkspaceAgentActivityServiceDependencies`:

```ts
reporterNow?: () => number;
reporterService?: Pick<IReporterService, "trackEvents">;
```

Import `IReporterService`, `AgentAnalyticsErrorCode`, and `createAgentNodeResultTracker`.

- [ ] **Step 4: Track event stream connect failure**

Inside `startEventStreamConnection().catch`:

```ts
void createAgentNodeResultTracker({
  reporterNow: this.dependencies.reporterNow,
  reporterService: this.dependencies.reporterService
}).failure({
  error,
  fallbackCode: AgentAnalyticsErrorCode.ActivityEventStreamFailed,
  flow: "runtime_activity",
  node: "activity_event_stream",
  provider: null
});
```

- [ ] **Step 5: Track reconcile failures**

Inside `reconcileAgentActivityUpdate` catch, after excluding not-found:

```ts
void createAgentNodeResultTracker({
  reporterNow: this.dependencies.reporterNow,
  reporterService: this.dependencies.reporterService
}).failure({
  agentSessionId,
  error,
  fallbackCode: AgentAnalyticsErrorCode.ActivityReconcileFailed,
  flow: "runtime_activity",
  node:
    input.eventType === "message_update"
      ? "activity_reconcile_messages"
      : "activity_reconcile_state",
  provider: null
});
```

- [ ] **Step 6: Run focused tests**

Run:

```sh
pnpm --filter @tutti-os/desktop test -- workspaceAgentActivityService
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7**

```sh
git add apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.ts apps/desktop/src/renderer/src/features/workspace-agent/services/internal/workspaceAgentActivityService.test.ts
git commit -m "feat(agent): track activity runtime failures"
```

## Task 8: Docs and Final Validation

**Files:**

- Modify: `docs/architecture/analytics-tracking.md`
- Modify: `docs/architecture/agent-gui-node.md` if runtime failure boundary needs a durable note.
- Test: full changed checks.

- [ ] **Step 1: Update analytics architecture docs**

Add a section to `docs/architecture/analytics-tracking.md`:

```md
## Agent Node Result Events

Agent setup, session creation, message sending, and runtime activity failures use
`agent.node_result` to report step-level success and failure. Every agent
analytics event carries `error_code` and `error_message`; success events set
`error_code` to `agent_error_none` and `error_message` to an empty string.

Runtime failure events cover infrastructure failures such as provider process
exit, network disconnect, runtime start/exec errors, daemon API failures, and
activity reconciliation failures. Agent task failures such as command/test/tool
call errors are not runtime failures and are not reported through
`agent.node_result`.
```

- [ ] **Step 2: Run renderer tests and typecheck**

Run:

```sh
pnpm --filter @tutti-os/desktop test
pnpm --filter @tutti-os/desktop typecheck
```

Expected: PASS.

- [ ] **Step 3: Run Go tests**

Run:

```sh
pnpm test:go
```

Expected: PASS.

- [ ] **Step 4: Run changed-aware validation**

Run:

```sh
pnpm check:changed
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

```sh
git add docs/architecture/analytics-tracking.md docs/architecture/agent-gui-node.md docs/specs/2026-06-29-agent-node-result-analytics-design.md docs/specs/2026-06-29-agent-node-result-analytics-plan.md
git commit -m "docs(agent): specify node result analytics"
```

## Self-Review

- Spec coverage: provider setup, login, install, session create, message send, runtime activity, error fields, enum requirement, and tool-call exclusion are all covered by tasks.
- 文档扫描：没有未决占位内容或未说明清楚的实施步骤。
- Type consistency: renderer uses camelCase reporter params that become snake_case through `BaseAnalyticsReporter`; Go params are already snake_case because daemon reporter params are raw maps.
- Scope: one feature slice, no independent subsystem needs a separate plan.
