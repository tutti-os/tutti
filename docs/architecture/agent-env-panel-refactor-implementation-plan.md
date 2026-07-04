# AgentEnvPanel controller+store Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `AgentEnvPanel.tsx` into a four-layer architecture (pure view-model / vanilla store / controller / hook) so the component only subscribes and renders, removing the effect-soup + ref-guard orchestration and the inline derivation leak.

**Architecture:** A pure i18n-agnostic view-model in `@tutti-os/agent-gui` absorbs all display derivation. A desktop vanilla `useSyncExternalStore` store holds transient wizard state (replacing 5 `useState` + 1 `useRef`). A desktop controller subscribes to the provider-status service and drives auto-start / anomaly-report / reveal orchestration synchronously off `getSnapshot()` (dedup key lives in the store, not a ref). A bridge hook wires it to a slimmed component tree.

**Tech Stack:** TypeScript, React 18 (`useSyncExternalStore`), vitest (agent-gui `*.spec.ts`, jsdom), node:test (desktop `*.test.ts`).

## Global Constraints

- **Radix Dialog must NOT unmount on `open=true→false`** — component always renders `<Dialog>`; `open` drives visibility. Unmounting while open strands `pointer-events: none` on `document.body`.
- **Do not modify** `agentEnvPanelStore.ts` (valtio) or the `openAgentEnvPanel`/`closeAgentEnvPanel` deep-link API — called across the `agent-gui` package.
- **adapter-version-mismatch must never red the CLI step** — reuse `reasonCodeIndicatesCliVersionUnsupported`; never use a bare `reasonCode.includes("version")`.
- **auto-start fires at most once per open**; **anomaly-report fires at most once per open**.
- **Provider resolution depends on the desktop constant `desktopManagedAgentProviders`** — keep it in the desktop layer, never in the shared pure module.
- Agent-gui tests: vitest, `*.spec.ts`, `import { describe, expect, it } from "vitest"`. Desktop tests: node:test, `*.test.ts`, `import test from "node:test"; import assert from "node:assert/strict";`.
- Reason-code string literals (exact): `codex_version_too_old`, `acp_adapter_version_mismatch`. Reveal constants: `REVEAL_STEP_MS = 450`, `REVEAL_ALL = Number.MAX_SAFE_INTEGER`.

**Relevant source (current):**

- `apps/desktop/src/renderer/src/features/workspace-agent/ui/AgentEnvPanel.tsx` (the file being decomposed; ~990 lines incl. `SetupTrack`).
- `packages/agent/gui/shared/agentEnv/agentEnvWizardFlow.ts` (existing pure flow; `AgentSetupStage`, `deriveAgentSetupStages`, `projectRevealedStages`, `shouldAdvanceReveal`, `stageRemediation`, `resolveWizardAutoStartAction`, `reasonCodeIndicatesCliVersionUnsupported`).
- `packages/agent/gui/shared/agentEnv/index.ts` (barrel — must re-export new symbols).
- `apps/desktop/.../services/agentProviderStatusService.interface.ts` (`IAgentProviderStatusService`, `AgentProviderStatusSnapshot`).
- Status shape: `AgentProviderStatus { provider, availability:{status,reasonCode?}, cli:{installed,binaryPath?,version?,minVersion?}, adapter:{installed,binaryPath?,command:string[],version?,requiredVersion?}, auth:{status,accountLabel?}, network?:{registry:{reachable,endpoint?},providerApi?:{reachable,endpoint?},proxy?:{configured,reachable,url?}} }`.

---

## Task 1: Token-ize `AgentSetupStage.detail` in the pure flow module

Makes stage detail i18n-agnostic so all detail derivation can move into the pure view-model. Currently `detail: string | null`; becomes a token union.

**Files:**

- Modify: `packages/agent/gui/shared/agentEnv/agentEnvWizardFlow.ts`
- Modify: `packages/agent/gui/shared/agentEnv/agentEnvWizardFlow.spec.ts`
- Modify: `packages/agent/gui/shared/agentEnv/index.ts`

**Interfaces:**

- Produces: `type StageDetailToken = { kind: "text"; text: string } | { kind: "version-floor"; current: string; required: string } | { kind: "version-mismatch"; current: string; required: string }`; `AgentSetupStage.detail: StageDetailToken | null`; `DeriveAgentSetupStagesInput.cliVersionDetail/adapterDetail/accountDetail/networkDetail: StageDetailToken | null`.

- [ ] **Step 1: Update the failing test first**

In `agentEnvWizardFlow.spec.ts`, find the existing `deriveAgentSetupStages` cases that pass string details (search for `cliVersionDetail:` / `accountDetail:`). Replace those string literals with tokens, e.g. a case that asserts the install stage carries its detail:

```ts
it("carries the cli version detail token on the install stage", () => {
  const stages = deriveAgentSetupStages({
    ...baseInput,
    detected: true,
    cliInstalled: true,
    cliVersionDetail: { kind: "text", text: "1.2.3 · /usr/bin/codex" }
  });
  const install = stages.find((s) => s.id === "install");
  expect(install?.detail).toEqual({
    kind: "text",
    text: "1.2.3 · /usr/bin/codex"
  });
});
```

(Use the file's existing `baseInput`/helper if present; otherwise inline a full `DeriveAgentSetupStagesInput`. Set every `*Detail` field to `null` except the one under test.)

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tutti-os/agent-gui test -- agentEnvWizardFlow`
Expected: FAIL — TypeScript error that `{ kind: "text", ... }` is not assignable to `string | null`.

- [ ] **Step 3: Change the types**

In `agentEnvWizardFlow.ts`, add the token type above `AgentSetupStage` and switch the detail fields:

```ts
export type StageDetailToken =
  | { kind: "text"; text: string }
  | { kind: "version-floor"; current: string; required: string }
  | { kind: "version-mismatch"; current: string; required: string };

export interface AgentSetupStage {
  id: AgentSetupStageId;
  label: string;
  status: CodexSetupStepStatus;
  detail: StageDetailToken | null;
}
```

In `DeriveAgentSetupStagesInput`, change `cliVersionDetail`, `adapterDetail`, `accountDetail`, `networkDetail` from `string | null` to `StageDetailToken | null`. The function body already assigns them straight through to `detail`, so no logic change is needed — only the type annotations.

- [ ] **Step 4: Re-export the token**

In `index.ts`, add `StageDetailToken` to the `export type { ... } from "./agentEnvWizardFlow.ts"` block.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tutti-os/agent-gui test -- agentEnvWizardFlow`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/agent/gui/shared/agentEnv/agentEnvWizardFlow.ts \
        packages/agent/gui/shared/agentEnv/agentEnvWizardFlow.spec.ts \
        packages/agent/gui/shared/agentEnv/index.ts
git commit -m "refactor(agent-env): token-ize AgentSetupStage.detail"
```

---

## Task 2: Pure view-model `agentEnvViewModel.ts`

Absorbs the inline derivation from `AgentEnvPanel.tsx` lines ~405–598 into one tested pure function.

**Files:**

- Create: `packages/agent/gui/shared/agentEnv/agentEnvViewModel.ts`
- Create: `packages/agent/gui/shared/agentEnv/agentEnvViewModel.spec.ts`
- Modify: `packages/agent/gui/shared/agentEnv/index.ts`

**Interfaces:**

- Consumes: from Task 1 `StageDetailToken`, `AgentSetupStage`; existing `deriveAgentSetupStages`, `projectRevealedStages`, `reasonCodeIndicatesCliVersionUnsupported`, `AgentSetupStageId`, `AgentSetupStageLabels`; `readCodexSetupActiveAction`, `CodexSetupActiveAction`, `CodexSetupActiveActionError`, `CodexSetupPhase`; `AgentProviderStatus`, `WorkspaceAgentProvider` from `@tutti-os/client-tuttid-ts`.
- Produces:
  - `interface NetworkCheck { kind: "registry" | "api" | "proxy"; reachable: boolean; host: string | null; configured?: boolean }`
  - `function deriveHasAnomaly(stages: AgentSetupStage[], activeActionError: CodexSetupActiveActionError | null): boolean`
  - `interface AgentEnvWizardViewModelInput { provider; status: AgentProviderStatus | null; isLoading: boolean; activeAction: CodexSetupActiveAction | null; installActionPending: boolean; loginPending: boolean; revealIndex: number; stageLabels: AgentSetupStageLabels }`
  - `interface AgentEnvWizardViewModel { provider; ready; busy; detected; redetecting; displayStages: AgentSetupStage[]; blockingStageId: AgentSetupStageId | null; networkChecks: NetworkCheck[]; hasAnomaly; activePhase: CodexSetupPhase | null; log: string[]; registry: string | null; error: CodexSetupActiveActionError | null; manualCommand: string | null; installPending; loginPending }`
  - `function buildAgentEnvWizardViewModel(input: AgentEnvWizardViewModelInput): AgentEnvWizardViewModel`

- [ ] **Step 1: Write the failing tests**

Create `agentEnvViewModel.spec.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildAgentEnvWizardViewModel,
  deriveHasAnomaly,
  type AgentEnvWizardViewModelInput
} from "./agentEnvViewModel";
import type { AgentProviderStatus } from "@tutti-os/client-tuttid-ts";

const LABELS = {
  detect: "检测",
  network: "网络",
  install: "安装",
  adapter: "适配器",
  login: "登录",
  ready: "就绪"
};

function status(
  overrides: Partial<AgentProviderStatus> = {}
): AgentProviderStatus {
  return {
    provider: "codex",
    availability: { status: "ready", reasonCode: null },
    cli: {
      installed: true,
      binaryPath: "/usr/bin/codex",
      version: "1.2.3",
      minVersion: "1.0.0"
    },
    adapter: {
      installed: true,
      binaryPath: "/opt/acp",
      command: ["acp"],
      version: "2.0.0",
      requiredVersion: "2.0.0"
    },
    auth: { status: "authenticated", accountLabel: "me@x.com" },
    actions: [],
    network: null,
    activeAction: null,
    ...overrides
  } as AgentProviderStatus;
}

function input(
  overrides: Partial<AgentEnvWizardViewModelInput> = {}
): AgentEnvWizardViewModelInput {
  return {
    provider: "codex",
    status: status(),
    isLoading: false,
    activeAction: null,
    installActionPending: false,
    loginPending: false,
    revealIndex: Number.MAX_SAFE_INTEGER,
    stageLabels: LABELS,
    ...overrides
  };
}

describe("buildAgentEnvWizardViewModel", () => {
  it("marks ready and all stages ok for a fully-configured provider", () => {
    const vm = buildAgentEnvWizardViewModel(input());
    expect(vm.ready).toBe(true);
    expect(vm.displayStages.every((s) => s.status === "ok")).toBe(true);
    expect(vm.blockingStageId).toBeNull();
  });

  it("shows the version-floor token when the CLI is below the supported floor", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: {
            status: "unavailable",
            reasonCode: "codex_version_too_old"
          },
          cli: {
            installed: true,
            version: "0.9.0",
            minVersion: "1.0.0",
            binaryPath: "/usr/bin/codex"
          }
        }),
        revealIndex: Number.MAX_SAFE_INTEGER
      })
    );
    const install = vm.displayStages.find((s) => s.id === "install");
    expect(install?.detail).toEqual({
      kind: "version-floor",
      current: "0.9.0",
      required: "1.0.0"
    });
    expect(install?.status).toBe("error");
  });

  it("does NOT red the install (CLI) stage on an adapter version mismatch", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: {
            status: "unavailable",
            reasonCode: "acp_adapter_version_mismatch"
          },
          adapter: {
            installed: true,
            version: "1.0.0",
            requiredVersion: "2.0.0",
            command: ["acp"],
            binaryPath: "/opt/acp"
          }
        })
      })
    );
    expect(vm.displayStages.find((s) => s.id === "install")?.status).toBe("ok");
    const adapter = vm.displayStages.find((s) => s.id === "adapter");
    expect(adapter?.status).toBe("error");
    expect(adapter?.detail).toEqual({
      kind: "version-mismatch",
      current: "1.0.0",
      required: "2.0.0"
    });
  });

  it("assembles network checks and treats an unconfigured proxy as reachable", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          network: {
            registry: {
              reachable: true,
              endpoint: "https://registry.npmjs.org"
            },
            providerApi: {
              reachable: false,
              endpoint: "https://api.openai.com/v1"
            },
            proxy: { configured: false, reachable: false, url: null }
          }
        })
      })
    );
    expect(vm.networkChecks).toEqual([
      { kind: "registry", reachable: true, host: "registry.npmjs.org" },
      { kind: "api", reachable: false, host: "api.openai.com" },
      { kind: "proxy", reachable: true, host: null, configured: false }
    ]);
  });

  it("surfaces the first non-ok stage as blocking once revealed", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          availability: { status: "auth_required", reasonCode: null },
          auth: { status: "required", accountLabel: null }
        })
      })
    );
    expect(vm.blockingStageId).toBe("login");
  });

  it("hides the blocking stage when the reveal cursor has not reached it", () => {
    const vm = buildAgentEnvWizardViewModel(
      input({
        status: status({
          auth: { status: "required", accountLabel: null },
          availability: { status: "auth_required", reasonCode: null }
        }),
        revealIndex: 0
      })
    );
    expect(vm.blockingStageId).toBeNull();
  });

  it("exposes the manual install command for codex", () => {
    expect(buildAgentEnvWizardViewModel(input()).manualCommand).toBe(
      "npm install -g @openai/codex --include=optional"
    );
  });
});

describe("deriveHasAnomaly", () => {
  it("is true when any stage is in error", () => {
    expect(
      deriveHasAnomaly(
        [{ id: "adapter", label: "x", status: "error", detail: null }],
        null
      )
    ).toBe(true);
  });
  it("is true when the active action carries an error", () => {
    expect(
      deriveHasAnomaly(
        [{ id: "ready", label: "x", status: "ok", detail: null }],
        { code: "boom", message: "failed" }
      )
    ).toBe(true);
  });
  it("is false for a clean not-yet-set-up flow", () => {
    expect(
      deriveHasAnomaly(
        [{ id: "login", label: "x", status: "pending", detail: null }],
        null
      )
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tutti-os/agent-gui test -- agentEnvViewModel`
Expected: FAIL — `buildAgentEnvWizardViewModel` not found.

- [ ] **Step 3: Implement the view-model**

Create `agentEnvViewModel.ts`. This is a faithful move of `AgentEnvPanel.tsx` lines ~405–598; the only changes are (a) detail strings become `StageDetailToken`, (b) it returns a struct instead of inline `const`s, (c) `endpointHost` and `MANUAL_INSTALL_COMMANDS` move here.

```ts
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import {
  deriveAgentSetupStages,
  projectRevealedStages,
  reasonCodeIndicatesCliVersionUnsupported,
  type AgentSetupStage,
  type AgentSetupStageId,
  type AgentSetupStageLabels,
  type StageDetailToken
} from "./agentEnvWizardFlow.ts";
import type {
  CodexSetupActiveAction,
  CodexSetupActiveActionError,
  CodexSetupPhase
} from "./codexSetupContract.ts";

export interface NetworkCheck {
  kind: "registry" | "api" | "proxy";
  reachable: boolean;
  host: string | null;
  configured?: boolean;
}

const MANUAL_INSTALL_COMMANDS: Partial<Record<WorkspaceAgentProvider, string>> =
  {
    codex: "npm install -g @openai/codex --include=optional",
    "claude-code": "curl -fsSL https://claude.ai/install.sh | bash"
  };

function endpointHost(endpoint: string | null | undefined): string | null {
  if (!endpoint) {
    return null;
  }
  return endpoint.replace(/^https?:\/\//, "").replace(/\/.*$/, "") || null;
}

function textToken(text: string | null): StageDetailToken | null {
  return text ? { kind: "text", text } : null;
}

function joinDetail(parts: Array<string | null | undefined>): string | null {
  const joined = parts.filter((p): p is string => Boolean(p)).join(" · ");
  return joined || null;
}

export function deriveHasAnomaly(
  stages: AgentSetupStage[],
  activeActionError: CodexSetupActiveActionError | null
): boolean {
  return stages.some((s) => s.status === "error") || Boolean(activeActionError);
}

export interface AgentEnvWizardViewModelInput {
  provider: WorkspaceAgentProvider;
  status: AgentProviderStatus | null;
  isLoading: boolean;
  activeAction: CodexSetupActiveAction | null;
  installActionPending: boolean;
  loginPending: boolean;
  revealIndex: number;
  stageLabels: AgentSetupStageLabels;
}

export interface AgentEnvWizardViewModel {
  provider: WorkspaceAgentProvider;
  ready: boolean;
  busy: boolean;
  detected: boolean;
  redetecting: boolean;
  displayStages: AgentSetupStage[];
  blockingStageId: AgentSetupStageId | null;
  networkChecks: NetworkCheck[];
  hasAnomaly: boolean;
  activePhase: CodexSetupPhase | null;
  log: string[];
  registry: string | null;
  error: CodexSetupActiveActionError | null;
  manualCommand: string | null;
  installPending: boolean;
  loginPending: boolean;
}

export function buildAgentEnvWizardViewModel(
  input: AgentEnvWizardViewModelInput
): AgentEnvWizardViewModel {
  const { status, activeAction, provider } = input;
  const ready = status?.availability.status === "ready";
  const installPending = input.installActionPending;
  const loginPending = input.loginPending;
  const busy =
    installPending ||
    activeAction?.phase === "install" ||
    activeAction?.phase === "repair" ||
    activeAction?.phase === "verify";

  const reasonCode = (status?.availability.reasonCode ?? "").toLowerCase();
  const versionTooOld = reasonCodeIndicatesCliVersionUnsupported(reasonCode);
  const cliBelowFloor = reasonCode.includes("codex_version_too_old");
  const adapterVersionMismatch = reasonCode.includes(
    "acp_adapter_version_mismatch"
  );

  const cliDetail: StageDetailToken | null =
    cliBelowFloor && status?.cli.version && status.cli.minVersion
      ? {
          kind: "version-floor",
          current: status.cli.version,
          required: status.cli.minVersion
        }
      : status?.cli.installed
        ? textToken(joinDetail([status?.cli.version, status?.cli.binaryPath]))
        : textToken(status?.cli.version ?? null);

  const adapterDetail: StageDetailToken | null =
    adapterVersionMismatch &&
    status?.adapter.version &&
    status?.adapter.requiredVersion
      ? {
          kind: "version-mismatch",
          current: status.adapter.version,
          required: status.adapter.requiredVersion
        }
      : status?.adapter.installed
        ? textToken(
            joinDetail([status?.adapter.version, status?.adapter.binaryPath])
          )
        : textToken(
            status?.adapter.binaryPath ??
              (status?.adapter.command?.length
                ? status.adapter.command.join(" ")
                : null)
          );

  const networkChecks: NetworkCheck[] = status?.network
    ? [
        {
          kind: "registry",
          reachable: status.network.registry.reachable,
          host: endpointHost(status.network.registry.endpoint)
        },
        ...(status.network.providerApi
          ? [
              {
                kind: "api" as const,
                reachable: status.network.providerApi.reachable,
                host: endpointHost(status.network.providerApi.endpoint)
              }
            ]
          : []),
        ...(status.network.proxy
          ? [
              {
                kind: "proxy" as const,
                reachable:
                  !status.network.proxy.configured ||
                  status.network.proxy.reachable,
                host: status.network.proxy.url ?? null,
                configured: status.network.proxy.configured
              }
            ]
          : [])
      ]
    : [];
  const networkReachable =
    networkChecks.length === 0 ? null : networkChecks.every((c) => c.reachable);

  const accountDetail: StageDetailToken | null = status?.auth.accountLabel
    ? { kind: "text", text: status.auth.accountLabel }
    : status?.auth.status === "authenticated"
      ? { kind: "text", text: "__SIGNED_IN__" }
      : null;

  const stages = deriveAgentSetupStages({
    detected: status !== null,
    cliInstalled: status?.cli.installed ?? false,
    versionTooOld,
    adapterInstalled: status?.adapter.installed ?? false,
    adapterVersionMismatch,
    authenticated: status?.auth.status === "authenticated",
    authRequired: status?.auth.status === "required",
    ready: Boolean(ready),
    activePhase: activeAction?.phase ?? null,
    installActionPending: installPending,
    loginPending,
    networkReachable,
    cliVersionDetail: cliDetail,
    adapterDetail,
    accountDetail,
    networkDetail: null,
    labels: input.stageLabels
  });

  const registry = activeAction?.registry ?? null;
  const stagesWithDetail = registry
    ? stages.map((s) =>
        s.id === "ready"
          ? { ...s, detail: { kind: "text" as const, text: registry } }
          : s
      )
    : stages;
  const displayStages = projectRevealedStages(
    stagesWithDetail,
    input.revealIndex
  );

  const blockingIndex = stages.findIndex((s) => s.status !== "ok");
  const blockingStage = blockingIndex >= 0 ? stages[blockingIndex] : undefined;
  const blockingStageId: AgentSetupStageId | null =
    blockingStage && input.revealIndex >= blockingIndex
      ? blockingStage.id
      : null;

  return {
    provider,
    ready: Boolean(ready),
    busy: Boolean(busy),
    detected: status !== null,
    redetecting: input.isLoading,
    displayStages,
    blockingStageId,
    networkChecks,
    hasAnomaly: deriveHasAnomaly(stages, activeAction?.error ?? null),
    activePhase: activeAction?.phase ?? null,
    log: activeAction?.log ?? [],
    registry,
    error: activeAction?.error ?? null,
    manualCommand: MANUAL_INSTALL_COMMANDS[provider] ?? null,
    installPending,
    loginPending
  };
}
```

> Note the `"__SIGNED_IN__"` sentinel: the "已登录" fallback string is i18n and is resolved in the component layer (Task 6). The component maps `{ kind: "text", text: "__SIGNED_IN__" }` to `t("workspace.agentEnv.valueSignedIn")`.

- [ ] **Step 4: Re-export from the barrel**

In `index.ts`, add:

```ts
export {
  buildAgentEnvWizardViewModel,
  deriveHasAnomaly
} from "./agentEnvViewModel.ts";
export type {
  AgentEnvWizardViewModel,
  AgentEnvWizardViewModelInput,
  NetworkCheck
} from "./agentEnvViewModel.ts";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tutti-os/agent-gui test -- agentEnvViewModel`
Expected: PASS (all 9 cases).

- [ ] **Step 6: Commit**

```bash
git add packages/agent/gui/shared/agentEnv/agentEnvViewModel.ts \
        packages/agent/gui/shared/agentEnv/agentEnvViewModel.spec.ts \
        packages/agent/gui/shared/agentEnv/index.ts
git commit -m "feat(agent-env): pure wizard view-model"
```

---

## Task 3: Desktop vanilla store `agentEnvWizardStore.ts`

Replaces the component's 5 `useState` + 1 `useRef` with a module store following `agentSessionViewStore.ts` conventions.

**Files:**

- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardStore.ts`
- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardStore.test.ts`

**Interfaces:**

- Consumes: `AgentEnvPanelFocus` from `@tutti-os/agent-gui` (`packages/.../agentEnvPanelStore.ts`).
- Produces: constants `REVEAL_STEP_MS = 450`, `REVEAL_ALL = Number.MAX_SAFE_INTEGER`; type `WizardReportState = "idle" | "confirming" | "reported" | "dismissed"`; interface `AgentEnvWizardSnapshot { revealIndex: number; reportState: WizardReportState; copied: boolean; logExpanded: boolean; autoStartedSeq: number | null }`; functions `resetWizardForOpen(focus)`, `restartWizardReveal()`, `advanceWizardReveal()`, `setWizardReportState(s)`, `setWizardCopied(b)`, `toggleWizardLog()`, `markWizardAutoStarted(seq)`, `getAgentEnvWizardSnapshot()`, `useAgentEnvWizardState()`, `subscribeAgentEnvWizardStore(listener)`, `resetAgentEnvWizardStoreForTests()`.

- [ ] **Step 1: Write the failing test**

Create `agentEnvWizardStore.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  advanceWizardReveal,
  getAgentEnvWizardSnapshot,
  markWizardAutoStarted,
  resetAgentEnvWizardStoreForTests,
  resetWizardForOpen,
  restartWizardReveal,
  setWizardReportState,
  REVEAL_ALL
} from "./agentEnvWizardStore.ts";

test("resetWizardForOpen parks reveal at REVEAL_ALL for a non-detect focus", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("install");
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, REVEAL_ALL);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "idle");
  assert.equal(getAgentEnvWizardSnapshot().autoStartedSeq, null);
});

test("resetWizardForOpen rewinds reveal to 0 for a detect focus", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("detect");
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 0);
});

test("advanceWizardReveal increments the cursor", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("detect");
  advanceWizardReveal();
  advanceWizardReveal();
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 2);
});

test("markWizardAutoStarted records the dedup sequence", () => {
  resetAgentEnvWizardStoreForTests();
  markWizardAutoStarted(7);
  assert.equal(getAgentEnvWizardSnapshot().autoStartedSeq, 7);
});

test("restartWizardReveal rewinds reveal and clears report state", () => {
  resetAgentEnvWizardStoreForTests();
  resetWizardForOpen("install");
  setWizardReportState("dismissed");
  restartWizardReveal();
  assert.equal(getAgentEnvWizardSnapshot().revealIndex, 0);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "idle");
});

test("subscribers fire on mutation", () => {
  resetAgentEnvWizardStoreForTests();
  let calls = 0;
  const { subscribeAgentEnvWizardStore } = require("./agentEnvWizardStore.ts");
  const unsub = subscribeAgentEnvWizardStore(() => {
    calls += 1;
  });
  advanceWizardReveal();
  unsub();
  advanceWizardReveal();
  assert.equal(calls, 1);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tutti-os/desktop test 2>&1 | grep -i agentEnvWizardStore` (or run the full `test` script)
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

Create `agentEnvWizardStore.ts`:

```ts
import { useSyncExternalStore } from "react";
import type { AgentEnvPanelFocus } from "@tutti-os/agent-gui/agent-env";

export const REVEAL_STEP_MS = 450;
export const REVEAL_ALL = Number.MAX_SAFE_INTEGER;

export type WizardReportState =
  | "idle"
  | "confirming"
  | "reported"
  | "dismissed";

export interface AgentEnvWizardSnapshot {
  revealIndex: number;
  reportState: WizardReportState;
  copied: boolean;
  logExpanded: boolean;
  autoStartedSeq: number | null;
}

const INITIAL: AgentEnvWizardSnapshot = {
  revealIndex: REVEAL_ALL,
  reportState: "idle",
  copied: false,
  logExpanded: false,
  autoStartedSeq: null
};

let snapshot: AgentEnvWizardSnapshot = INITIAL;
const listeners = new Set<() => void>();

function set(next: Partial<AgentEnvWizardSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  for (const listener of listeners) {
    listener();
  }
}

export function resetWizardForOpen(focus: AgentEnvPanelFocus | null): void {
  set({
    revealIndex: focus === "detect" ? 0 : REVEAL_ALL,
    reportState: "idle",
    copied: false,
    logExpanded: false,
    autoStartedSeq: null
  });
}

export function restartWizardReveal(): void {
  set({
    revealIndex: 0,
    reportState: "idle",
    copied: false,
    logExpanded: false
  });
}

export function advanceWizardReveal(): void {
  set({ revealIndex: snapshot.revealIndex + 1 });
}

export function setWizardReportState(reportState: WizardReportState): void {
  set({ reportState });
}

export function setWizardCopied(copied: boolean): void {
  set({ copied });
}

export function toggleWizardLog(): void {
  set({ logExpanded: !snapshot.logExpanded });
}

export function markWizardAutoStarted(seq: number): void {
  set({ autoStartedSeq: seq });
}

export function getAgentEnvWizardSnapshot(): AgentEnvWizardSnapshot {
  return snapshot;
}

export function subscribeAgentEnvWizardStore(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAgentEnvWizardState(): AgentEnvWizardSnapshot {
  return useSyncExternalStore(
    subscribeAgentEnvWizardStore,
    getAgentEnvWizardSnapshot
  );
}

export function resetAgentEnvWizardStoreForTests(): void {
  snapshot = INITIAL;
  listeners.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tutti-os/desktop test 2>&1 | grep -iE "agentEnvWizardStore|pass|fail"`
Expected: PASS (6 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardStore.ts \
        apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardStore.test.ts
git commit -m "feat(agent-env): desktop vanilla wizard store"
```

---

## Task 4: Desktop controller `agentEnvWizardController.ts`

Replaces the 4 component effects with one `attach()`/`detach()` orchestration that subscribes to the service.

**Files:**

- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardController.ts`
- Create: `apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardController.test.ts`

**Interfaces:**

- Consumes: `IAgentProviderStatusService`, `AgentProviderStatusActionContext` from the service interface; `AgentEnvPanelFocus`, `resolveWizardAutoStartAction`, `shouldAdvanceReveal`, `buildAgentEnvWizardViewModel`, `deriveHasAnomaly`, `readCodexSetupActiveAction` from `@tutti-os/agent-gui/agent-env`; `WorkspaceAgentProvider` from client; store functions + `REVEAL_STEP_MS` from Task 3.
- Produces: `interface AttachAgentEnvWizardParams { service; provider: WorkspaceAgentProvider; focus: AgentEnvPanelFocus | null; requestSequence: number; context: { workspaceId: string; workbenchHost?: unknown }; scheduler?: { setTimeout: (cb: () => void, ms: number) => number; clearTimeout: (id: number) => void } }`; `function attachAgentEnvWizard(p): () => void`; `function restartAgentEnvWizardDetection(p): void`.

- [ ] **Step 1: Write the failing tests**

Create `agentEnvWizardController.test.ts`. The fake service implements only the methods the controller calls:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AgentProviderStatus,
  WorkspaceAgentProvider
} from "@tutti-os/client-tuttid-ts";
import type {
  AgentProviderStatusSnapshot,
  IAgentProviderStatusService
} from "../agentProviderStatusService.interface.ts";
import {
  attachAgentEnvWizard,
  type AttachAgentEnvWizardParams
} from "./agentEnvWizardController.ts";
import {
  getAgentEnvWizardSnapshot,
  resetAgentEnvWizardStoreForTests
} from "./agentEnvWizardStore.ts";

function readyStatus(): AgentProviderStatus {
  return {
    provider: "codex",
    availability: { status: "ready", reasonCode: null },
    cli: {
      installed: true,
      version: "1.2.3",
      binaryPath: "/c",
      minVersion: "1.0.0"
    },
    adapter: {
      installed: true,
      command: ["acp"],
      version: "2.0.0",
      requiredVersion: "2.0.0",
      binaryPath: "/a"
    },
    auth: { status: "authenticated", accountLabel: "me" },
    actions: [],
    network: null,
    activeAction: null
  } as AgentProviderStatus;
}

function missingCliStatus(): AgentProviderStatus {
  return {
    ...readyStatus(),
    availability: { status: "unavailable", reasonCode: "cli_not_installed" },
    cli: {
      installed: false,
      version: null,
      binaryPath: null,
      minVersion: "1.0.0"
    },
    auth: { status: "required", accountLabel: null }
  } as AgentProviderStatus;
}

class FakeService implements Partial<IAgentProviderStatusService> {
  snapshot: AgentProviderStatusSnapshot;
  listeners = new Set<() => void>();
  runActionCalls: Array<{ provider: string; actionId: string }> = [];
  reportCalls: string[] = [];
  refreshCalls = 0;
  ensureCalls = 0;
  pending = new Set<string>();
  consent = false;

  constructor(status: AgentProviderStatus) {
    this.snapshot = {
      error: null,
      isLoading: false,
      pendingActions: [],
      statuses: [status],
      capturedAt: null,
      defaultProvider: "codex"
    };
  }
  getSnapshot() {
    return this.snapshot;
  }
  subscribe(l: () => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  isActionPending(_p: WorkspaceAgentProvider, a: string) {
    return this.pending.has(a);
  }
  async refresh() {
    this.refreshCalls += 1;
  }
  async ensureLoaded() {
    this.ensureCalls += 1;
    return null;
  }
  async runAction(p: WorkspaceAgentProvider, a: string) {
    this.runActionCalls.push({ provider: p, actionId: a });
  }
  getDiagnosticsConsent() {
    return this.consent;
  }
  setDiagnosticsConsent(v: boolean) {
    this.consent = v;
  }
  async reportEnvIssue(p: WorkspaceAgentProvider) {
    this.reportCalls.push(p);
  }
  emit() {
    for (const l of this.listeners) l();
  }
}

function params(
  service: FakeService,
  over: Partial<AttachAgentEnvWizardParams> = {}
): AttachAgentEnvWizardParams {
  return {
    service: service as unknown as IAgentProviderStatusService,
    provider: "codex",
    focus: "install",
    requestSequence: 1,
    context: { workspaceId: "w1" },
    scheduler: { setTimeout: () => 0, clearTimeout: () => {} },
    ...over
  };
}

test("auto-start fires runAction exactly once across multiple service ticks", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(missingCliStatus());
  const detach = attachAgentEnvWizard(params(service));
  service.emit();
  service.emit();
  service.emit();
  detach();
  assert.equal(service.runActionCalls.length, 1);
  assert.deepEqual(service.runActionCalls[0], {
    provider: "codex",
    actionId: "install"
  });
});

test("auto-start does not fire when already ready", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(readyStatus());
  const detach = attachAgentEnvWizard(params(service));
  service.emit();
  detach();
  assert.equal(service.runActionCalls.length, 0);
});

test("non-remediation focus does not auto-start", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(missingCliStatus());
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  service.emit();
  detach();
  assert.equal(service.runActionCalls.length, 0);
});

test("anomaly with consent reports once and sets reported", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService({
    ...missingCliStatus(),
    availability: {
      status: "unavailable",
      reasonCode: "acp_adapter_version_mismatch"
    },
    adapter: {
      installed: true,
      version: "1.0.0",
      requiredVersion: "2.0.0",
      command: ["acp"],
      binaryPath: "/a"
    }
  } as AgentProviderStatus);
  service.consent = true;
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  service.emit();
  service.emit();
  detach();
  assert.equal(service.reportCalls.length, 1);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "reported");
});

test("anomaly without consent moves to confirming and does not report", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService({
    ...missingCliStatus(),
    availability: {
      status: "unavailable",
      reasonCode: "acp_adapter_version_mismatch"
    },
    adapter: {
      installed: true,
      version: "1.0.0",
      requiredVersion: "2.0.0",
      command: ["acp"],
      binaryPath: "/a"
    }
  } as AgentProviderStatus);
  const detach = attachAgentEnvWizard(params(service, { focus: "detect" }));
  service.emit();
  detach();
  assert.equal(service.reportCalls.length, 0);
  assert.equal(getAgentEnvWizardSnapshot().reportState, "confirming");
});

test("attach with a focus refreshes; detect focus uses ensureLoaded only when no focus", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(readyStatus());
  const detach = attachAgentEnvWizard(params(service, { focus: "install" }));
  detach();
  assert.equal(service.refreshCalls, 1);
  assert.equal(service.ensureCalls, 0);
});

test("detach unsubscribes so later ticks are ignored", () => {
  resetAgentEnvWizardStoreForTests();
  const service = new FakeService(missingCliStatus());
  const detach = attachAgentEnvWizard(params(service));
  detach();
  service.emit();
  assert.equal(service.runActionCalls.length, 0);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @tutti-os/desktop test 2>&1 | grep -iE "agentEnvWizardController|fail"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the controller**

Create `agentEnvWizardController.ts`:

```ts
import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  resolveWizardAutoStartAction,
  shouldAdvanceReveal,
  type AgentEnvPanelFocus,
  type AgentSetupStageLabels
} from "@tutti-os/agent-gui/agent-env";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { IAgentProviderStatusService } from "../agentProviderStatusService.interface.ts";
import {
  advanceWizardReveal,
  getAgentEnvWizardSnapshot,
  markWizardAutoStarted,
  resetWizardForOpen,
  restartWizardReveal,
  setWizardReportState,
  REVEAL_STEP_MS
} from "./agentEnvWizardStore.ts";

// Reveal/auto-start/anomaly are status-driven, not label-driven; the orchestrator
// only needs stage *status*, so it feeds the view-model placeholder labels.
const ORCHESTRATION_LABELS: AgentSetupStageLabels = {
  detect: "",
  network: "",
  install: "",
  adapter: "",
  login: "",
  ready: ""
};

interface Scheduler {
  setTimeout: (cb: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
}

export interface AttachAgentEnvWizardParams {
  service: IAgentProviderStatusService;
  provider: WorkspaceAgentProvider;
  focus: AgentEnvPanelFocus | null;
  requestSequence: number;
  context: { workspaceId: string; workbenchHost?: unknown };
  scheduler?: Scheduler;
}

function defaultScheduler(): Scheduler {
  return {
    setTimeout: (cb, ms) => window.setTimeout(cb, ms),
    clearTimeout: (id) => window.clearTimeout(id)
  };
}

function buildOrchestrationViewModel(params: AttachAgentEnvWizardParams) {
  const snap = params.service.getSnapshot();
  const status =
    snap.statuses.find((s) => s.provider === params.provider) ?? null;
  return buildAgentEnvWizardViewModel({
    provider: params.provider,
    status,
    isLoading: snap.isLoading,
    activeAction: readCodexSetupActiveAction(status),
    installActionPending: params.service.isActionPending(
      params.provider,
      "install"
    ),
    loginPending: params.service.isActionPending(params.provider, "login"),
    revealIndex: getAgentEnvWizardSnapshot().revealIndex,
    stageLabels: ORCHESTRATION_LABELS
  });
}

export function attachAgentEnvWizard(
  params: AttachAgentEnvWizardParams
): () => void {
  const scheduler = params.scheduler ?? defaultScheduler();
  let revealTimer: number | null = null;
  let detached = false;

  resetWizardForOpen(params.focus);
  if (params.focus) {
    void params.service.refresh([params.provider]);
  } else {
    void params.service.ensureLoaded({ providers: [params.provider] });
  }

  const clearRevealTimer = (): void => {
    if (revealTimer !== null) {
      scheduler.clearTimeout(revealTimer);
      revealTimer = null;
    }
  };

  const orchestrate = (): void => {
    if (detached) {
      return;
    }
    const snap = params.service.getSnapshot();
    const status =
      snap.statuses.find((s) => s.provider === params.provider) ?? null;
    const wizard = getAgentEnvWizardSnapshot();

    // auto-start (dedup key in store; mark BEFORE running so re-entrant ticks no-op)
    if (wizard.autoStartedSeq !== params.requestSequence) {
      const action = resolveWizardAutoStartAction({
        focus: params.focus,
        detected: !snap.isLoading && status !== null,
        ready: status?.availability.status === "ready",
        installPending: params.service.isActionPending(
          params.provider,
          "install"
        ),
        loginPending: params.service.isActionPending(params.provider, "login")
      });
      if (action) {
        markWizardAutoStarted(params.requestSequence);
        void params.service.runAction(params.provider, action, params.context);
      }
    }

    // anomaly report (once per open)
    if (wizard.reportState === "idle") {
      const vm = buildOrchestrationViewModel(params);
      if (vm.hasAnomaly) {
        if (params.service.getDiagnosticsConsent()) {
          void params.service.reportEnvIssue(params.provider);
          setWizardReportState("reported");
        } else {
          setWizardReportState("confirming");
        }
      }
    }

    // reveal advance (timer re-arms after each advance via re-running orchestrate)
    clearRevealTimer();
    const vm = buildOrchestrationViewModel(params);
    if (
      shouldAdvanceReveal(
        vm.displayStages,
        getAgentEnvWizardSnapshot().revealIndex
      )
    ) {
      revealTimer = scheduler.setTimeout(() => {
        revealTimer = null;
        advanceWizardReveal();
        orchestrate();
      }, REVEAL_STEP_MS);
    }
  };

  const unsubscribe = params.service.subscribe(orchestrate);
  orchestrate();

  return () => {
    detached = true;
    clearRevealTimer();
    unsubscribe();
  };
}

export function restartAgentEnvWizardDetection(
  params: AttachAgentEnvWizardParams
): void {
  restartWizardReveal();
  setWizardReportState("idle");
  void params.service.refresh([params.provider]);
}
```

> `shouldAdvanceReveal` reads stage _real_ status. `buildOrchestrationViewModel` projects with the live reveal index; `displayStages` before the cursor keep real status, so `shouldAdvanceReveal(displayStages, revealIndex)` evaluates the stage AT the cursor correctly. (If a subagent finds the projection masks the cursor stage, switch to deriving raw stages via a `revealIndex: REVEAL_ALL` view-model — both are status-equivalent at/under the cursor. Verify with the "reveal advances" behavior in the component test, Task 6.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @tutti-os/desktop test 2>&1 | grep -iE "agentEnvWizardController|pass|fail"`
Expected: PASS (7 cases).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardController.ts \
        apps/desktop/src/renderer/src/features/workspace-agent/services/internal/agentEnvWizardController.test.ts
git commit -m "feat(agent-env): desktop wizard orchestration controller"
```

---

## Task 5: Bridge hook `useAgentEnvWizard.ts`

The component's single entry point: subscribes to service + wizard store, resolves provider, builds the view-model, manages the attach/detach lifecycle, and exposes stable action callbacks.

**Files:**

- Create: `apps/desktop/src/renderer/src/features/workspace-agent/ui/useAgentEnvWizard.ts`

**Interfaces:**

- Consumes: `IAgentProviderStatusService`; `useAgentEnvPanelRequest`/`AgentEnvPanelRequest`, `buildAgentEnvWizardViewModel`, `readCodexSetupActiveAction`, `AgentEnvWizardViewModel`, `StageActionId` from `@tutti-os/agent-gui/agent-env`; `desktopManagedAgentProviders`, `isDesktopManagedAgentProvider`; store hook `useAgentEnvWizardState` + mutators; `attachAgentEnvWizard`/`restartAgentEnvWizardDetection`; `useTranslation`.
- Produces: `interface AgentEnvWizardActions { redetect(): void; runStageAction(actionId: StageActionId): void; confirmReport(): void; dismissReport(): void; copyManual(command: string): void; toggleLog(): void }`; `function useAgentEnvWizard(input): { provider; isSupported: boolean; viewModel: AgentEnvWizardViewModel; reportState: WizardReportState; copied: boolean; logExpanded: boolean; actions: AgentEnvWizardActions }`.

- [ ] **Step 1: Implement the hook (no separate unit test — covered by the component test in Task 6)**

Create `useAgentEnvWizard.ts`:

```ts
import { useCallback, useEffect, useMemo } from "react";
import { useSyncExternalStore } from "react";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import {
  buildAgentEnvWizardViewModel,
  readCodexSetupActiveAction,
  useAgentEnvPanelRequest,
  type AgentEnvWizardViewModel,
  type StageActionId
} from "@tutti-os/agent-gui/agent-env";
import { useTranslation } from "@renderer/i18n";
import type { IAgentProviderStatusService } from "../services/agentProviderStatusService.interface";
import {
  desktopManagedAgentProviders,
  isDesktopManagedAgentProvider
} from "../services/internal/desktopManagedAgentProviders.ts";
import {
  attachAgentEnvWizard,
  restartAgentEnvWizardDetection
} from "../services/internal/agentEnvWizardController.ts";
import {
  setWizardCopied,
  setWizardReportState,
  toggleWizardLog,
  useAgentEnvWizardState,
  type WizardReportState
} from "../services/internal/agentEnvWizardStore.ts";

function useStatusSnapshot(service: IAgentProviderStatusService) {
  return useSyncExternalStore(
    (l) => service.subscribe(l),
    () => service.getSnapshot()
  );
}

function resolveActiveProvider(
  requested: string | null,
  defaultProvider: WorkspaceAgentProvider | null
): WorkspaceAgentProvider {
  if (requested && isDesktopManagedAgentProvider(requested)) {
    return requested;
  }
  if (defaultProvider && isDesktopManagedAgentProvider(defaultProvider)) {
    return defaultProvider;
  }
  return desktopManagedAgentProviders.includes("codex")
    ? "codex"
    : desktopManagedAgentProviders[0];
}

export interface AgentEnvWizardActions {
  redetect(): void;
  runStageAction(actionId: StageActionId): void;
  confirmReport(): void;
  dismissReport(): void;
  copyManual(command: string): void;
  toggleLog(): void;
}

export function useAgentEnvWizard(input: {
  service: IAgentProviderStatusService;
  workspaceId: string;
  workbenchHost?: unknown;
}): {
  provider: WorkspaceAgentProvider;
  isSupported: boolean;
  viewModel: AgentEnvWizardViewModel;
  reportState: WizardReportState;
  copied: boolean;
  logExpanded: boolean;
  actions: AgentEnvWizardActions;
} {
  const { service, workspaceId, workbenchHost } = input;
  const { t } = useTranslation();
  const request = useAgentEnvPanelRequest();
  const snapshot = useStatusSnapshot(service);
  const wizard = useAgentEnvWizardState();

  const provider = useMemo(
    () => resolveActiveProvider(request.provider, snapshot.defaultProvider),
    [request.provider, snapshot.defaultProvider]
  );

  const status = useMemo(
    () => snapshot.statuses.find((s) => s.provider === provider) ?? null,
    [snapshot.statuses, provider]
  );

  const attachParams = useMemo(
    () => ({
      service,
      provider,
      focus: request.focus,
      requestSequence: request.requestSequence,
      context: { workspaceId, workbenchHost }
    }),
    [
      service,
      provider,
      request.focus,
      request.requestSequence,
      workspaceId,
      workbenchHost
    ]
  );

  // Single lifecycle effect: synchronize the orchestrator with the open panel.
  useEffect(() => {
    if (!request.open) {
      return;
    }
    return attachAgentEnvWizard(attachParams);
  }, [request.open, attachParams]);

  const stageLabels = useMemo(
    () => ({
      detect: t("workspace.agentEnv.stageDetect"),
      network: t("workspace.agentEnv.stageNetwork"),
      install: t("workspace.agentEnv.stageInstall"),
      adapter: t("workspace.agentEnv.stageAdapter"),
      login: t("workspace.agentEnv.stageLogin"),
      ready: t("workspace.agentEnv.stageReady")
    }),
    [t]
  );

  const viewModel = useMemo(
    () =>
      buildAgentEnvWizardViewModel({
        provider,
        status,
        isLoading: snapshot.isLoading,
        activeAction: readCodexSetupActiveAction(status),
        installActionPending: service.isActionPending(provider, "install"),
        loginPending: service.isActionPending(provider, "login"),
        revealIndex: wizard.revealIndex,
        stageLabels
      }),
    [
      provider,
      status,
      snapshot.isLoading,
      snapshot.pendingActions,
      service,
      wizard.revealIndex,
      stageLabels
    ]
  );

  const redetect = useCallback(
    () => restartAgentEnvWizardDetection(attachParams),
    [attachParams]
  );
  const runStageAction = useCallback(
    (actionId: StageActionId) => {
      if (actionId === "redetect") {
        restartAgentEnvWizardDetection(attachParams);
        return;
      }
      void service.runAction(provider, actionId, {
        workbenchHost,
        workspaceId
      });
    },
    [attachParams, service, provider, workbenchHost, workspaceId]
  );
  const confirmReport = useCallback(() => {
    service.setDiagnosticsConsent(true);
    void service.reportEnvIssue(provider);
    setWizardReportState("reported");
  }, [service, provider]);
  const dismissReport = useCallback(
    () => setWizardReportState("dismissed"),
    []
  );
  const copyManual = useCallback(async (command: string) => {
    try {
      await navigator.clipboard?.writeText(command);
      setWizardCopied(true);
    } catch {
      setWizardCopied(false);
    }
  }, []);
  const toggleLog = useCallback(() => toggleWizardLog(), []);

  return {
    provider,
    isSupported: isDesktopManagedAgentProvider(provider),
    viewModel,
    reportState: wizard.reportState,
    copied: wizard.copied,
    logExpanded: wizard.logExpanded,
    actions: {
      redetect,
      runStageAction,
      confirmReport,
      dismissReport,
      copyManual: (c) => void copyManual(c),
      toggleLog
    }
  };
}
```

> `copyManual` returns a promise; the action wrapper discards it (`void`) to keep the `AgentEnvWizardActions` signature synchronous.

- [ ] **Step 2: Type-check**

Run: `pnpm --filter @tutti-os/desktop typecheck`
Expected: no errors in `useAgentEnvWizard.ts`. (Compilation is the gate here; behavior is exercised by the Task 4 controller suite.)

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/renderer/src/features/workspace-agent/ui/useAgentEnvWizard.ts
git commit -m "feat(agent-env): bridge hook for the wizard"
```

---

## Task 6: Slim the component tree

Rewrite `AgentEnvPanel.tsx` to consume the hook; extract `SetupTrack` and the consent block; centralize i18n token mapping.

**Files:**

- Create: `apps/desktop/.../workspace-agent/ui/agentEnvPanelText.ts`
- Create: `apps/desktop/.../workspace-agent/ui/AgentEnvSetupTrack.tsx`
- Create: `apps/desktop/.../workspace-agent/ui/AgentEnvReportConsent.tsx`
- Modify: `apps/desktop/.../workspace-agent/ui/AgentEnvPanel.tsx`
- Modify (if present): existing `AgentEnvPanel` render test under `workspace-agent/ui/`.

**Interfaces:**

- Consumes: Task 5 `useAgentEnvWizard`, `AgentEnvWizardViewModel`, `AgentEnvWizardActions`; `NetworkCheck`, `StageDetailToken`, `AgentSetupStage`, `AgentSetupStageId`, `StageProblem`, `stageRemediation` from `@tutti-os/agent-gui/agent-env`.
- Produces: `agentEnvPanelText.ts` exports `resolveProviderLabel(provider): string`, `renderStageDetail(token: StageDetailToken | null, t): string | null`, `describeStageProblem(problem, providerLabel, t)`, `doneStageLabel(stageId, t)`.

- [ ] **Step 1: Create `agentEnvPanelText.ts`**

Move `PROVIDER_LABELS`/`resolveProviderLabel` (current `AgentEnvPanel.tsx:69–88`), `describeStageProblem` (`:122–172`), `doneStageLabel` (`:177–195`) here verbatim, and add the token renderer:

```ts
import type {
  AgentSetupStageId,
  StageDetailToken,
  StageProblem
} from "@tutti-os/agent-gui/agent-env";
import type { WorkspaceAgentProvider } from "@tutti-os/client-tuttid-ts";
import type { useTranslation } from "@renderer/i18n";

type T = ReturnType<typeof useTranslation>["t"];

// ...PROVIDER_LABELS, resolveProviderLabel, describeStageProblem, doneStageLabel
// moved verbatim from AgentEnvPanel.tsx...

export function renderStageDetail(
  token: StageDetailToken | null,
  t: T
): string | null {
  if (!token) {
    return null;
  }
  if (token.kind === "version-floor") {
    return t("workspace.agentEnv.stageInstallVersionRequirement", {
      current: token.current,
      required: token.required
    });
  }
  if (token.kind === "version-mismatch") {
    return t("workspace.agentEnv.stageAdapterVersionRequirement", {
      current: token.current,
      required: token.required
    });
  }
  if (token.text === "__SIGNED_IN__") {
    return t("workspace.agentEnv.valueSignedIn");
  }
  return token.text;
}
```

- [ ] **Step 2: Create `AgentEnvSetupTrack.tsx`**

Move the entire `SetupTrack` function (current `AgentEnvPanel.tsx:711–989`) into this file. Apply these prop-shape changes: replace the 21-prop signature with `{ viewModel, actions, t }`. Inside, derive locals from `viewModel` (`const { displayStages: stages, networkChecks, activePhase, log, registry, blockingStageId, manualCommand, copied, logExpanded, error, loginPending, installPending, redetecting, ready, busy } = viewModel`-style, except `copied`/`logExpanded` come from props since they're wizard-store-owned — pass them through `viewModel`? No: keep `copied`/`logExpanded` as explicit props from the hook result). Concretely the new signature:

```tsx
export function AgentEnvSetupTrack({
  viewModel,
  providerLabel,
  copied,
  logExpanded,
  actions,
  t
}: {
  viewModel: AgentEnvWizardViewModel;
  providerLabel: string;
  copied: boolean;
  logExpanded: boolean;
  actions: AgentEnvWizardActions;
  t: ReturnType<typeof useTranslation>["t"];
}): JSX.Element {
  /* body moved from SetupTrack */
}
```

Body edits (mechanical):

- `stage.detail` is now a token → render via `renderStageDetail(stageDetail, t)`. The running-log override becomes `const stageDetail: StageDetailToken | null = hasLog ? { kind: "text", text: latestLogLine(log) ?? "" } : stage.detail;`.
- `onRunStageAction(actionId)` → `actions.runStageAction(actionId)`.
- `onToggleLog` → `actions.toggleLog`; `onCopyManualCommand(cmd)` → `actions.copyManual(cmd)`.
- `loginPending`/`installPending`/`redetecting`/`ready`/`busy`/`activePhase`/`log`/`registry`/`blockingStageId`/`networkChecks`/`manualCommand`/`error` all read from `viewModel.*`.
- Keep `latestLogLine` and `StepStatusIcon` (move them into this file from `AgentEnvPanel.tsx:197–227` and `:219–227`).

- [ ] **Step 3: Create `AgentEnvReportConsent.tsx`**

Extract the consent block (current `AgentEnvPanel.tsx:659–681`):

```tsx
export function AgentEnvReportConsent({
  onCancel,
  onAgree,
  t
}: {
  onCancel: () => void;
  onAgree: () => void;
  t: ReturnType<typeof useTranslation>["t"];
}): JSX.Element {
  /* the <div className="shrink-0 border-t ...">…</div> moved verbatim,
     with onClick={() => setReportState("dismissed")} → onClick={onCancel}
     and onClick={handleConfirmReport} → onClick={onAgree} */
}
```

- [ ] **Step 4: Rewrite `AgentEnvPanel.tsx`**

Replace the whole container body. Keep the Radix no-unmount comment block (current `:397–403`). New body:

```tsx
import { type JSX } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  RefreshIcon
} from "@tutti-os/ui-system";
import {
  closeAgentEnvPanel,
  useAgentEnvPanelRequest
} from "@tutti-os/agent-gui/agent-env";
import { useTranslation } from "@renderer/i18n";
import type { IAgentProviderStatusService } from "../services/agentProviderStatusService.interface";
import { useAgentEnvWizard } from "./useAgentEnvWizard";
import { AgentEnvSetupTrack } from "./AgentEnvSetupTrack";
import { AgentEnvReportConsent } from "./AgentEnvReportConsent";
import { resolveProviderLabel } from "./agentEnvPanelText";

interface AgentEnvPanelProps {
  agentProviderStatusService: IAgentProviderStatusService;
  workspaceId: string;
  workbenchHost?: unknown;
}

export function AgentEnvPanel({
  agentProviderStatusService,
  workspaceId,
  workbenchHost
}: AgentEnvPanelProps): JSX.Element | null {
  const { t } = useTranslation();
  const request = useAgentEnvPanelRequest();
  const {
    provider,
    isSupported,
    viewModel,
    reportState,
    copied,
    logExpanded,
    actions
  } = useAgentEnvWizard({
    service: agentProviderStatusService,
    workspaceId,
    workbenchHost
  });
  const providerLabel = resolveProviderLabel(provider);

  // Do NOT early-return null when closed (Radix controlled dialog; see history).
  return (
    <Dialog
      open={request.open}
      onOpenChange={(next) => {
        if (!next) closeAgentEnvPanel();
      }}
    >
      <DialogContent className="flex max-h-[min(640px,calc(100vh-32px))] flex-col gap-0 overflow-hidden bg-[var(--background-fronted)] p-0 sm:max-w-[560px]">
        <DialogHeader className="shrink-0 border-b border-[var(--border-1)] px-5 py-4">
          <DialogTitle>
            {t("workspace.agentEnv.configTitle", { provider: providerLabel })}
          </DialogTitle>
          <DialogDescription>
            {viewModel.ready
              ? t("workspace.agentEnv.configDescription", {
                  provider: providerLabel
                })
              : t("workspace.agentEnv.wizardDescription", {
                  provider: providerLabel
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {!isSupported ? (
            <p className="m-0 text-[13px] text-[var(--text-secondary)]">
              {t("workspace.agentEnv.providerUnsupported")}
            </p>
          ) : (
            <AgentEnvSetupTrack
              viewModel={viewModel}
              providerLabel={providerLabel}
              copied={copied}
              logExpanded={logExpanded}
              actions={actions}
              t={t}
            />
          )}
        </div>

        {reportState === "confirming" ? (
          <AgentEnvReportConsent
            onCancel={actions.dismissReport}
            onAgree={actions.confirmReport}
            t={t}
          />
        ) : null}

        <DialogFooter className="flex shrink-0 items-center justify-between gap-2 border-t border-[var(--border-1)] px-5 py-4">
          <Button
            size="dialog"
            type="button"
            variant="ghost"
            disabled={viewModel.redetecting}
            onClick={actions.redetect}
          >
            <RefreshIcon className="size-4" />
            {t("workspace.agentEnv.actionDetect")}
          </Button>
          <Button
            size="dialog"
            type="button"
            onClick={() => closeAgentEnvPanel()}
          >
            {t("workspace.agentEnv.actionClose")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

Delete from `AgentEnvPanel.tsx`: all `useState`/`useEffect`/`useRef`/`useMemo`, `NetworkCheck`, `endpointHost`, `MANUAL_INSTALL_COMMANDS`, the `SetupTrack` function, `StepStatusIcon`, `latestLogLine`, and the moved text helpers.

- [ ] **Step 5: Confirm no broken component test (no new `.tsx` test)**

The desktop test runner is `node --test --experimental-strip-types "./src/**/*.test.ts"` — it globs only `*.test.ts` and cannot strip JSX, so React render (`.test.tsx`) tests do not run in this package. **Do not add one.** Component-level behavior is already covered without JSX: the view-model logic by Task 2 (vitest) and the auto-start/anomaly/reveal orchestration by Task 4 (node:test).

Action: `grep -rn "AgentEnvPanel\|SetupTrack" apps/desktop/src/renderer/src/features/workspace-agent --include=*.test.ts` — if any non-`.tsx` test references the old `SetupTrack`/inline symbols, update its imports to the new module paths. Expected: only `desktopAgentProviderStatusService.test.ts` (untouched by this refactor) matches; if so, nothing to change.

- [ ] **Step 6: Run the full affected suites**

Run:

```bash
pnpm --filter @tutti-os/agent-gui test -- agentEnv
pnpm --filter @tutti-os/desktop test 2>&1 | grep -iE "agentEnv|pass|fail"
```

Expected: all PASS.

- [ ] **Step 7: Lint + typecheck the renderer feature boundary**

Run: `pnpm --filter @tutti-os/desktop typecheck && node ./tools/scripts/check-renderer-feature-boundaries.mjs`
Expected: no errors. (The hook imports the controller/store from `../services/internal`; confirm that direction is allowed — `AgentEnvPanel` already imports from `../services/internal/desktopManagedAgentProviders.ts`, so it is.)

- [ ] **Step 8: Commit**

```bash
git add apps/desktop/src/renderer/src/features/workspace-agent/ui/
git commit -m "refactor(agent-env): slim AgentEnvPanel onto controller+store+view-model"
```

---

## Verification (acceptance, run after Task 6)

- [ ] `AgentEnvPanel.tsx` contains no `useEffect`, `useRef`, or `useState` (grep returns nothing): `grep -nE "useEffect|useRef|useState" apps/desktop/src/renderer/src/features/workspace-agent/ui/AgentEnvPanel.tsx` → empty.
- [ ] No `autoStartedSeqRef` / "do not weaken the ref guard" remains: `grep -rn "autoStartedSeqRef\|weaken the ref" apps/desktop/src/renderer/src/features/workspace-agent` → empty.
- [ ] `AgentEnvSetupTrack` prop interface has ≤ 4 fields.
- [ ] No bare `reasonCode.includes("version")` anywhere; only `reasonCodeIndicatesCliVersionUnsupported` and the two exact literal `.includes(...)` checks live in `agentEnvViewModel.ts`.
- [ ] All new specs/tests green; existing `desktopAgentProviderStatusService.test.ts` still green.

## Self-Review Notes (spec coverage)

- Spec §"纯 view-model" → Tasks 1–2. §"vanilla store" → Task 3. §"controller" → Task 4. §"hook" → Task 5. §"组件层" → Task 6.
- Spec constraint "去重键进 store" → Task 3 `autoStartedSeq` + Task 4 `markWizardAutoStarted` before `runAction`; asserted by Task 4 "fires exactly once across multiple ticks".
- Spec constraint "adapter 不红 CLI" → Task 2 dedicated test.
- Spec constraint "Radix 不卸载" → Task 6 keeps `<Dialog>` always rendered + comment.
- Spec "deriveHasAnomaly 共用" → defined in Task 2, consumed by Task 4 orchestrate + Task 2 vm.
- Out-of-scope items (valtio migration, `Codex*` rename, `workbenchHost` typing) intentionally untouched.
