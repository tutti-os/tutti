import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { normalizeAgentActivitySession } from "@tutti-os/agent-activity-core";
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode
} from "react";
import { agentGuiDockIconUrls } from "../dockIcons.ts";
import type {
  AgentGUIAgent,
  AgentGUIAgentDirectoryPort,
  AgentGUIProvider
} from "../types.ts";
import {
  AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
  agentGuiWorkbenchDefaultCopy,
  agentGuiWorkbenchProviderRailWidthPx,
  buildAgentGuiDockEntries,
  agentGuiWorkbenchNewWindowCascadeOffset,
  createAgentGuiWorkbenchContribution,
  resolveAgentGuiWorkbenchDefaultLaunchFrame,
  resolveAgentGuiWorkbenchContributionCopy
} from "./contribution.ts";
import {
  agentGuiWorkbenchPrefillPromptActivationType,
  agentGuiWorkbenchUnifiedDockEntryId,
  agentGuiWorkbenchTypeId
} from "./launch.ts";
import type { AgentGuiWorkbenchState } from "./types.ts";
import { createTestAgentSessionEngine } from "../shared/testing/createTestAgentSessionEngine.ts";

function createAgent(
  provider: AgentGUIProvider,
  overrides: Partial<AgentGUIAgent> = {}
): AgentGUIAgent {
  return {
    agentTargetId: `local:${provider}`,
    name: provider,
    iconUrl: `app://icons/${provider}.png`,
    availability: { status: "ready" },
    provider,
    ...overrides
  };
}

function readDockEntryIconImageSrcs(icon: ReactNode): string[] {
  if (!isValidElement(icon)) {
    return [];
  }
  const props = (icon as ReactElement<{ children?: ReactNode; src?: string }>)
    .props;
  return [
    ...(typeof props.src === "string" ? [props.src] : []),
    ...Children.toArray(props.children).flatMap(readDockEntryIconImageSrcs)
  ];
}

function createTestAgentGuiWorkbenchContribution(
  input: Omit<
    Parameters<typeof createAgentGuiWorkbenchContribution>[0],
    "agentDirectory"
  > & {
    agentDirectory?: AgentGUIAgentDirectoryPort;
    agents?: readonly AgentGUIAgent[];
    agentsLoading?: boolean;
  }
) {
  const {
    agentDirectory,
    agents = [createAgent("codex")],
    agentsLoading = false,
    ...contributionInput
  } = input;
  return createAgentGuiWorkbenchContribution({
    ...contributionInput,
    agentDirectory:
      agentDirectory ?? createTestAgentDirectory(agents, agentsLoading)
  });
}

function createTestAgentDirectory(
  agents: readonly AgentGUIAgent[],
  loading = false
): AgentGUIAgentDirectoryPort {
  return {
    getSnapshot: () => ({
      agents,
      capturedAtUnixMs: loading ? null : 1,
      error: null,
      status: loading ? "loading" : "ready"
    }),
    subscribe: () => () => {}
  };
}

const testLaunchLayout = {
  layoutConstraints: {
    minHeight: 160,
    minWidth: 280,
    safeArea: {
      bottom: 0,
      left: 0,
      right: 0,
      top: 0
    },
    surfacePadding: 0
  },
  surfaceSize: {
    height: 800,
    width: 1200
  }
};
describe("agent GUI workbench contribution copy", () => {
  it("builds one unified dock entry with the selected default target payload", () => {
    const claudeTarget = createAgent("claude-code");
    const entries = buildAgentGuiDockEntries({
      agentDirectory: createTestAgentDirectory([
        createAgent("codex"),
        claudeTarget
      ]),
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        "claude-code": true,
        codex: false
      }
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(agentGuiWorkbenchUnifiedDockEntryId());
    expect(entries[0]?.label).toBe("Agent");
    expect(entries[0]?.launchPayload).toEqual({
      agentTargetId: "local:claude-code",
      provider: "claude-code"
    });
  });

  it("preserves new-window behavior for a host-defined dock entry id", () => {
    const [entry] = buildAgentGuiDockEntries({
      agentDirectory: createTestAgentDirectory([createAgent("codex")]),
      defaultProvider: "codex",
      dockEntryId: "agentGui:shared",
      order: 7
    });

    expect(entry).toMatchObject({
      id: "agentGui:shared",
      newWindowLaunchPayload: {
        openInNewWindow: true
      },
      order: 7
    });
  });

  it("uses the unified icon URL for unified dock entries", () => {
    const entries = buildAgentGuiDockEntries({
      agentDirectory: createTestAgentDirectory([createAgent("codex")]),
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        codex: true
      },
      unifiedDockIconUrl: "app://icons/agent-unified.png"
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.icon).toMatchObject({
      props: {
        className:
          "agent-gui-workbench-dock-icon agent-gui-workbench-dock-icon--single"
      }
    });
    expect(readDockEntryIconImageSrcs(entries[0]?.icon)).toEqual([
      "app://icons/agent-unified.png"
    ]);
    expect(entries[0]?.launchPayload).toMatchObject({
      provider: "codex"
    });
  });

  it("uses the first enabled target in host order after an unavailable default provider", () => {
    const disabledClaudeTarget = {
      ...createAgent("claude-code"),
      agentTargetId: "disabled-claude",
      availability: { status: "unavailable" as const }
    };
    const enabledClaudeTarget = {
      ...createAgent("claude-code"),
      agentTargetId: "daemon-claude"
    };
    const entries = buildAgentGuiDockEntries({
      agentDirectory: createTestAgentDirectory([
        createAgent("codex"),
        disabledClaudeTarget,
        enabledClaudeTarget
      ]),
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        "claude-code": true,
        codex: false
      }
    });

    expect(entries[0]?.launchPayload).toEqual({
      agentTargetId: "daemon-claude",
      provider: "claude-code"
    });
  });

  it("uses host target order for an available default provider", () => {
    const daemonCodexTarget = {
      ...createAgent("codex"),
      agentTargetId: "daemon-codex"
    };
    const localCodexTarget = createAgent("codex");
    const entries = buildAgentGuiDockEntries({
      agentDirectory: createTestAgentDirectory([
        daemonCodexTarget,
        localCodexTarget
      ]),
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        codex: true
      }
    });

    expect(entries[0]?.launchPayload).toEqual({
      agentTargetId: "daemon-codex",
      provider: "codex"
    });
  });

  it("uses canonical dock affinity without fallback node matchers", () => {
    const [entry] = buildAgentGuiDockEntries({
      agentDirectory: createTestAgentDirectory([]),
      defaultProvider: "codex",
      providerAvailability: {}
    });

    expect(entry?.id).toBe(agentGuiWorkbenchUnifiedDockEntryId());
    expect(entry?.matchNode).toBeUndefined();
    expect(entry?.instanceMode).toBe("single");
    expect(entry?.newWindowLaunchPayload).toMatchObject({
      openInNewWindow: true
    });
    expect(entry?.allowNewWindowInDockPopup).toBe(false);
  });

  it("keeps unified launch payload provider priority when opening a session", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: {
        agentSessionId: "session-claude-1",
        provider: "claude-code"
      },
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(launchResult).toMatchObject({
      activation: {
        payload: {
          agentSessionId: "session-claude-1"
        },
        type: "agent-gui:open-session"
      },
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      title: "Agent"
    });
    expect(launchResult?.instanceId).toMatch(/^agent-gui:instance:/);
  });

  it("clears stale target state when opening a session without a target payload", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const baseRequest = {
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      layoutConstraints: testLaunchLayout.layoutConstraints,
      reason: "host" as const,
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    };

    const seededLaunch = contribution.onLaunchRequest?.({
      ...baseRequest,
      payload: {
        agentSessionId: "session-codex-1",
        agentTargetId: "local:claude-code",
        provider: "codex"
      }
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: seededLaunch?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toMatchObject({
      agentTargetId: "local:claude-code",
      lastActiveAgentSessionId: "session-codex-1"
    });

    const relaunch = contribution.onLaunchRequest?.({
      ...baseRequest,
      payload: {
        agentSessionId: "session-codex-1",
        provider: "codex"
      }
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(relaunch?.instanceId).toBe(seededLaunch?.instanceId);
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: relaunch?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toEqual({
      conversationRailCollapsed: false,
      conversationRailWidthPx: null,
      lastActiveAgentSessionId: "session-codex-1"
    });
  });

  it("opens prefill launches in a fresh node without overwriting an active session", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const baseRequest = {
      dockEntryId: "agent-gui",
      layoutConstraints: testLaunchLayout.layoutConstraints,
      reason: "host" as const,
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    };

    const sessionLaunch = contribution.onLaunchRequest?.({
      ...baseRequest,
      payload: {
        agentSessionId: "session-codex-1",
        agentTargetId: "local:codex",
        provider: "codex"
      }
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    const prefillLaunch = contribution.onLaunchRequest?.({
      ...baseRequest,
      payload: {
        agentTargetId: "local:codex",
        draftPrompt: "Handle this issue",
        provider: "codex"
      }
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(prefillLaunch?.instanceId).not.toBe(sessionLaunch?.instanceId);
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: prefillLaunch?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toEqual({
      agentTargetId: "local:codex",
      conversationRailCollapsed: false,
      conversationRailWidthPx: null,
      lastActiveAgentSessionId: null
    });
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: sessionLaunch?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toEqual({
      agentTargetId: "local:codex",
      conversationRailCollapsed: false,
      conversationRailWidthPx: null,
      lastActiveAgentSessionId: "session-codex-1"
    });
  });

  it("resolves unified empty dock launches lazily from current provider availability", () => {
    const claudeTarget = createAgent("claude-code");
    let currentAgents = [createAgent("codex")];
    const agentDirectory: AgentGUIAgentDirectoryPort = {
      getSnapshot: () => ({
        agents: currentAgents,
        capturedAtUnixMs: 1,
        error: null,
        status: "ready"
      }),
      subscribe: () => () => {}
    };
    const contribution = createTestAgentGuiWorkbenchContribution({
      agentDirectory,
      defaultProvider: "codex",
      providerAvailability: {},
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    expect(dockEntry?.launchPayload).toMatchObject({
      provider: "codex"
    });
    currentAgents = [claudeTarget];

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.launchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(launchResult).toMatchObject({
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      reuseDockEntryNode: true,
      title: "Agent"
    });
    expect(launchResult?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toMatchObject({
      agentTargetId: "local:claude-code"
    });
  });

  it("keeps one contribution while dock launches and body reads follow live directory updates", () => {
    let currentAgents = [createAgent("codex")];
    const listeners = new Set<() => void>();
    const agentDirectory: AgentGUIAgentDirectoryPort = {
      getSnapshot: () => ({
        agents: currentAgents,
        capturedAtUnixMs: 1,
        error: null,
        status: "ready"
      }),
      subscribe: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    };
    const renderedAgentTargetIds: string[][] = [];
    const contribution = createTestAgentGuiWorkbenchContribution({
      agentDirectory,
      defaultProvider: "codex",
      providerAvailability: {},
      renderBody: (_context, helpers) => {
        renderedAgentTargetIds.push(
          helpers.agentDirectory
            .getSnapshot()
            .agents.map((agent) => agent.agentTargetId)
        );
        return null;
      },
      workspaceId: "workspace-1"
    });
    const contributionIdentity = contribution;
    const nodeDefinition = contribution.nodes?.[0];
    const dockEntry = contribution.dockEntries?.[0];
    let bodyRenderRequests = 0;
    const unsubscribe = agentDirectory.subscribe(() => {
      bodyRenderRequests += 1;
    });

    const bodyContext = {
      instanceId: "agent-gui:codex:target:local%3Acodex"
    } as never;
    nodeDefinition?.renderBody?.(bodyContext);
    expect(renderedAgentTargetIds).toEqual([["local:codex"]]);

    currentAgents = [createAgent("claude-code")];
    for (const listener of listeners) listener();
    expect(bodyRenderRequests).toBe(1);
    nodeDefinition?.renderBody?.(bodyContext);

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.launchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as { instanceId: string } | null | undefined;

    expect(contribution).toBe(contributionIdentity);
    expect(contribution.nodes?.[0]).toBe(nodeDefinition);
    expect(nodeDefinition?.window?.header).toEqual({
      border: "none",
      layout: "overlay"
    });
    expect(renderedAgentTargetIds).toEqual([
      ["local:codex"],
      ["local:claude-code"]
    ]);
    expect(launchResult?.instanceId).toMatch(/^agent-gui:instance:/);
    unsubscribe();
  });

  it("seeds unified launch descriptor target state without changing provider identity", () => {
    const claudeTarget = createAgent("claude-code");
    const contribution = createTestAgentGuiWorkbenchContribution({
      defaultProvider: "claude-code",
      agents: [createAgent("codex"), claudeTarget],
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.launchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(launchResult).toMatchObject({
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      reuseDockEntryNode: true,
      title: "Agent"
    });
    expect(launchResult?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toEqual({
      conversationRailCollapsed: false,
      conversationRailWidthPx: null,
      lastActiveAgentSessionId: null,
      agentTargetId: "local:claude-code"
    });
  });

  it("opens a fresh cascading window for the dock 'New window' payload", () => {
    const claudeTarget = createAgent("claude-code");
    const contribution = createTestAgentGuiWorkbenchContribution({
      defaultProvider: "claude-code",
      agents: [createAgent("codex"), claudeTarget],
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    // The regular launch can reuse the contribution's opaque target binding...
    expect(dockEntry?.launchPayload).not.toHaveProperty("openInNewWindow");
    expect(dockEntry?.allowNewWindowInDockPopup).toBe(false);
    // ...while the "New window" payload forces a fresh window.
    expect(dockEntry?.newWindowLaunchPayload).toMatchObject({
      openInNewWindow: true
    });

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.newWindowLaunchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          cascadeOffset?: { x: number; y: number };
          instanceId: string;
        }
      | null
      | undefined;

    // A unique opaque per-launch instance so
    // the workbench opens a new node instead of re-focusing the existing one.
    expect(launchResult?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(launchResult?.cascadeOffset).toBeDefined();
    // The new window still commits to the resolved target/provider.
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toMatchObject({
      agentTargetId: "local:claude-code"
    });
  });

  it("opens a fresh unified Agent node from the dock popup new-window action", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      launchSource: "dock-popup-new-window",
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.launchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          cascadeOffset?: { x: number; y: number };
          dockEntryId?: string;
          reuseDockEntryNode?: boolean;
        }
      | null
      | undefined;

    expect(launchResult).toMatchObject({
      cascadeOffset: agentGuiWorkbenchNewWindowCascadeOffset,
      dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
      reuseDockEntryNode: false
    });
  });

  it("does not seed fallback target state while provider targets are loading", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      agents: [],
      agentsLoading: true,
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.launchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(launchResult).toBeNull();
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toBeNull();
  });

  it("does not seed fallback target state when provider targets are explicitly empty", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      agents: [],
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    const launchResult = contribution.onLaunchRequest?.({
      dockEntryId: dockEntry?.id,
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: dockEntry?.launchPayload,
      reason: "dock",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: agentGuiWorkbenchTypeId,
      workspaceId: "workspace-1"
    }) as
      | {
          instanceId: string;
        }
      | null
      | undefined;

    expect(launchResult).toBeNull();
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toBeNull();
  });

  it("uses package defaults when the host does not provide copy", () => {
    expect(resolveAgentGuiWorkbenchContributionCopy()).toEqual(
      agentGuiWorkbenchDefaultCopy
    );

    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    expect(contribution.nodes?.[0]?.title).toBe(
      agentGuiWorkbenchDefaultCopy.nodeTitle
    );
  });

  it("lets hosts override only the copy they own", () => {
    expect(
      resolveAgentGuiWorkbenchContributionCopy({
        nodeTitle: "Assistant"
      })
    ).toEqual({
      ...agentGuiWorkbenchDefaultCopy,
      nodeTitle: "Assistant"
    });
  });

  it("uses packaged dock icons when the host does not provide icon URLs", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchUnifiedDockEntryId()
    );

    expect(readDockEntryIconImageSrcs(dockEntry?.icon)).toEqual([
      agentGuiDockIconUrls.codex,
      agentGuiDockIconUrls["claude-code"],
      agentGuiDockIconUrls["tutti-agent"]
    ]);
  });

  it("lets hosts override packaged dock icons explicitly", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      dockIconUrls: {
        codex: "app://icons/codex.png"
      },
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchUnifiedDockEntryId()
    );

    expect(readDockEntryIconImageSrcs(dockEntry?.icon)).toEqual([
      "app://icons/codex.png",
      agentGuiDockIconUrls["claude-code"],
      agentGuiDockIconUrls["tutti-agent"]
    ]);
  });

  it("renders the left agent window title while the rail is expanded", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      dockIconUrls: {
        codex: "tutti-asset://agent/codex.png"
      },
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: null,
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Agent"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    expect(screen.getByText("Agent")).toHaveClass(
      "agent-gui-workbench-header__agent-name"
    );
    expect(screen.queryByText("Codex")).toBeNull();
    expect(screen.queryByTestId("agent-gui-window-session-icon")).toBeNull();
  });

  it("uses prefill activation provider for handoff body rendering", () => {
    const renderBody = vi.fn(() => null);
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody,
      workspaceId: "workspace-1"
    });

    contribution.nodes?.[0]?.renderBody?.({
      activation: {
        payload: {
          agentTargetId: "local:codex",
          draftPrompt: "Continue from this session",
          provider: "codex"
        },
        sequence: 12,
        type: agentGuiWorkbenchPrefillPromptActivationType
      },
      externalNodeState: null,
      externalWorkspaceState: null,
      instanceId: "agent-gui:claude-code:panel:handoff-source",
      instanceKey: null,
      node: {
        data: {
          runtimeNodeState: null
        },
        displayMode: "floating",
        frame: { height: 560, width: 1040, x: 0, y: 0 },
        id: "agent-gui-node-1",
        title: "Agent"
      }
    } as Parameters<
      NonNullable<(typeof contribution.nodes)[number]["renderBody"]>
    >[0]);

    expect(renderBody).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        provider: "codex"
      })
    );
  });

  it("opens at 90 percent width and height of the visible workbench area", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 560, width: 1040, x: 140, y: 48 },
      request: {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 79,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 900,
          width: 1440
        }
      }
    });

    expect(frame).toEqual({
      height: 692,
      width: 1296,
      x: 72,
      y: 91
    });
  });

  it("keeps the 90 percent width on compact visible workbench areas", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 560, width: 1040, x: 140, y: 48 },
      request: {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 79,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 700,
          width: 980
        }
      }
    });

    expect(frame).toEqual({
      height: 512,
      width: 882,
      x: 49,
      y: 81
    });
  });

  it("uses 90 percent of the visible height when the remaining workbench height is compact", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 560, width: 1040, x: 140, y: 48 },
      request: {
        layoutConstraints: {
          minHeight: 160,
          minWidth: 280,
          safeArea: {
            bottom: 79,
            left: 0,
            right: 0,
            top: 52
          },
          surfacePadding: 0
        },
        surfaceSize: {
          height: 747,
          width: 1440
        }
      }
    });

    expect(frame).toEqual({
      height: 554,
      width: 1296,
      x: 72,
      y: 83
    });
  });

  it("preserves the visible-area frame during compact launches", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const launchResult = contribution.onLaunchRequest?.({
      layoutConstraints: {
        minHeight: 160,
        minWidth: 280,
        safeArea: {
          bottom: 79,
          left: 0,
          right: 0,
          top: 52
        },
        surfacePadding: 0
      },
      dockEntryId: "agent-gui:codex",
      payload: { provider: "codex" },
      reason: "dock",
      surfaceSize: {
        height: 700,
        width: 980
      },
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    });

    expect(launchResult).toMatchObject({
      defaultFrame: {
        height: 512,
        width: 882,
        x: 49,
        y: 81
      },
      framePolicy: "absolute"
    });
  });

  it("opens requested sessions in new panel instances when explicitly requested", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const baseRequest = {
      layoutConstraints: {
        minHeight: 160,
        minWidth: 280,
        safeArea: {
          bottom: 79,
          left: 0,
          right: 0,
          top: 52
        },
        surfacePadding: 0
      },
      reason: "host" as const,
      surfaceSize: {
        height: 900,
        width: 1440
      },
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    };

    const existingLaunch = await contribution.onLaunchRequest?.({
      ...baseRequest,
      payload: {
        agentSessionId: "session-1",
        provider: "codex"
      }
    });
    const newWindowLaunch = await contribution.onLaunchRequest?.({
      ...baseRequest,
      payload: {
        agentSessionId: "session-1",
        openInNewWindow: true,
        provider: "codex"
      }
    });

    expect(existingLaunch?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(newWindowLaunch?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(newWindowLaunch?.instanceId).not.toBe(existingLaunch?.instanceId);
    expect(existingLaunch?.cascadeOffset).toBeUndefined();
    expect(newWindowLaunch?.cascadeOffset).toEqual(
      agentGuiWorkbenchNewWindowCascadeOffset
    );
    expect(newWindowLaunch?.activation).toEqual({
      payload: {
        agentSessionId: "session-1"
      },
      type: "agent-gui:open-session"
    });
  });

  it("preserves the frame of an already-open session window when re-launched (e.g. from a completion notification)", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const baseRequest = {
      layoutConstraints: {
        minHeight: 160,
        minWidth: 280,
        safeArea: {
          bottom: 79,
          left: 0,
          right: 0,
          top: 52
        },
        surfacePadding: 0
      },
      reason: "host" as const,
      surfaceSize: {
        height: 900,
        width: 1440
      },
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    };
    const payload = {
      agentSessionId: "session-1",
      provider: "codex"
    };

    const firstLaunch = await contribution.onLaunchRequest?.({
      ...baseRequest,
      payload
    });
    const relaunch = await contribution.onLaunchRequest?.({
      ...baseRequest,
      payload
    });

    expect(firstLaunch?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(relaunch?.instanceId).toBe(firstLaunch?.instanceId);
    expect(firstLaunch?.preserveExistingNodeFrame).not.toBe(true);
    expect(relaunch?.preserveExistingNodeFrame).toBe(true);
  });

  it("keeps different sessions on the same target in different nodes", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const baseRequest = {
      layoutConstraints: testLaunchLayout.layoutConstraints,
      reason: "host" as const,
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    };
    const launchSession = (agentSessionId: string) =>
      contribution.onLaunchRequest?.({
        ...baseRequest,
        payload: {
          agentSessionId,
          agentTargetId: "local:codex",
          provider: "codex"
        }
      });

    const firstSessionLaunch = await launchSession("session-1");
    const secondSessionLaunch = await launchSession("session-2");
    const secondSessionRelaunch = await launchSession("session-2");

    expect(firstSessionLaunch?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(secondSessionLaunch?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(secondSessionLaunch?.instanceId).not.toBe(
      firstSessionLaunch?.instanceId
    );
    expect(secondSessionRelaunch?.instanceId).toBe(
      secondSessionLaunch?.instanceId
    );
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: firstSessionLaunch?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toMatchObject({
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: "session-1"
    });
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: secondSessionLaunch?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toMatchObject({
      agentTargetId: "local:codex",
      lastActiveAgentSessionId: "session-2"
    });
  });

  it("does not treat a drifted session-keyed window as the requested session", async () => {
    let rememberState: ((state: AgentGuiWorkbenchState) => void) | null = null;
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: (_context, helpers) => {
        rememberState = helpers.onStateChange;
        return null;
      },
      workspaceId: "workspace-1"
    });

    contribution.nodes?.[0]?.renderBody?.({
      activation: null,
      externalNodeState: null,
      externalWorkspaceState: null,
      instanceId: "agent-gui:codex:session:session-1",
      instanceKey: null,
      node: {
        data: {
          runtimeNodeState: null
        },
        displayMode: "floating",
        frame: { height: 560, width: 1040, x: 0, y: 0 },
        id: "legacy-session-node",
        title: "Agent"
      }
    } as Parameters<
      NonNullable<(typeof contribution.nodes)[number]["renderBody"]>
    >[0]);
    expect(rememberState).not.toBeNull();
    (rememberState as unknown as (state: AgentGuiWorkbenchState) => void)({
      conversationRailCollapsed: false,
      conversationRailWidthPx: null,
      lastActiveAgentSessionId: "session-2"
    });

    const relaunch = await contribution.onLaunchRequest?.({
      layoutConstraints: testLaunchLayout.layoutConstraints,
      payload: {
        agentSessionId: "session-1",
        provider: "codex"
      },
      reason: "host",
      surfaceSize: testLaunchLayout.surfaceSize,
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    });

    expect(relaunch?.instanceId).not.toBe("agent-gui:codex:session:session-1");
    expect(relaunch?.instanceId).toMatch(/^agent-gui:instance:/);
    expect(relaunch?.preserveExistingNodeFrame).not.toBe(true);
  });

  it("keeps compact new-window session launches on the cascade policy", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    const launchResult = await contribution.onLaunchRequest?.({
      layoutConstraints: {
        minHeight: 160,
        minWidth: 280,
        safeArea: {
          bottom: 79,
          left: 0,
          right: 0,
          top: 52
        },
        surfacePadding: 0
      },
      payload: {
        agentSessionId: "session-1",
        openInNewWindow: true,
        provider: "codex"
      },
      reason: "host",
      surfaceSize: {
        height: 700,
        width: 980
      },
      typeId: "agent-gui",
      workspaceId: "workspace-1"
    });

    expect(launchResult).toMatchObject({
      cascadeOffset: agentGuiWorkbenchNewWindowCascadeOffset,
      defaultFrame: {
        height: 512,
        width: 882,
        x: 49,
        y: 81
      },
      framePolicy: "cascade-same-type-centered"
    });
  });

  it("matches codex panel nodes and only renders popup previews through the host renderer", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchUnifiedDockEntryId()
    );
    expect(dockEntry).toBeDefined();

    const node = {
      data: {
        dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
        instanceId: "agent-gui:codex:panel:test-1",
        typeId: agentGuiWorkbenchTypeId
      },
      id: "agent-gui:agent-gui:codex:panel:test-1",
      title: "Codex"
    };

    expect(dockEntry?.matchNode).toBeUndefined();
    expect(
      dockEntry?.providePopupItemPreview?.({
        externalNodeState: {
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Implement dock previews"
        },
        externalWorkspaceState: null,
        host: {} as never,
        isFocused: false,
        isMinimized: false,
        node: node as never
      }) ?? null
    ).toBeNull();
  });

  it("leaves agent GUI dock popup previews to the host image capture", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchUnifiedDockEntryId()
    );
    expect(dockEntry).toBeDefined();

    expect(dockEntry?.providePopupItemPreview).toBeUndefined();
  });

  it("uses host snapshot capture for agent GUI minimized slots", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const minimizedDock = contribution.nodes?.[0]?.window?.minimizedDock;
    expect(minimizedDock).toEqual({ kind: "snapshot" });
  });

  it("shows a new-session action when collapsed", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });
    const events: CustomEvent[] = [];
    const handler = (event: Event) => {
      events.push(event as CustomEvent);
    };
    window.addEventListener(
      AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
      handler
    );

    try {
      render(
        contribution.nodes?.[0]?.renderHeader?.({
          activation: null,
          defaultActions: null,
          displayMode: "floating",
          dragHandleProps: {},
          externalNodeState: {
            conversationRailCollapsed: true,
            lastActiveAgentSessionId: null
          },
          externalWorkspaceState: null,
          instanceId: "agent-gui:codex:panel:test-1",
          instanceKey: null,
          isFocused: true,
          node: {
            data: {
              runtimeNodeState: null
            },
            displayMode: "floating",
            frame: { height: 560, width: 1040, x: 0, y: 0 },
            id: "agent-gui-node-1",
            title: "Codex"
          },
          surfaceSize: { height: 800, width: 1200 },
          windowActions: {
            applyQuickLayout: () => {},
            close: () => {},
            focus: () => {},
            minimize: () => {},
            resize: () => {},
            toggleDisplayMode: () => {}
          }
        } as never) ?? null
      );

      fireEvent.click(
        screen.getByRole("button", {
          name: agentGuiWorkbenchDefaultCopy.newConversation
        })
      );
    } finally {
      window.removeEventListener(
        AGENT_GUI_WORKBENCH_NEW_CONVERSATION_EVENT,
        handler
      );
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      instanceId: "agent-gui:codex:panel:test-1"
    });
  });

  it("shows the active session icon and title when the rail is collapsed", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      resolveDockPopupIdentity: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? {
              iconUrl: "tutti-asset://agent/codex-session.png",
              title: "Current session title"
            }
          : null,
      workspaceId: "workspace-1"
    });

    const close = vi.fn();
    const minimize = vi.fn();
    const toggleDisplayMode = vi.fn();

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: {
          conversationRailCollapsed: true,
          lastActiveAgentSessionId: "session-1"
        },
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Codex"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close,
          focus: () => {},
          minimize,
          resize: () => {},
          toggleDisplayMode
        }
      } as never) ?? null
    );

    const newConversationButton = screen.getByRole("button", {
      name: agentGuiWorkbenchDefaultCopy.newConversation
    });
    const toggleButton = screen.getByTestId(
      "agent-gui-toggle-conversation-rail"
    );
    const header = document.querySelector(
      '[data-agent-gui-workbench-header="true"]'
    );
    const primary = document.querySelector(
      "[data-agent-gui-workbench-header-primary='true']"
    );

    expect(header).toHaveAttribute(
      "data-agent-gui-workbench-header-collapsed",
      "true"
    );
    expect(header).toHaveAttribute(
      "data-agent-gui-workbench-header-body-error",
      "false"
    );
    expect(primary).not.toHaveTextContent("Agent");
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.queryByText("Codex")).toBeNull();
    expect(toggleButton).toHaveClass("agent-gui-workbench-header__icon-button");
    expect(toggleButton).toHaveClass("agent-gui-workbench-header__rail-toggle");
    expect(toggleButton).toHaveAttribute("data-size", "icon-sm");
    expect(toggleButton.querySelector("svg")).toHaveClass(
      "agent-gui-workbench-header__icon"
    );
    expect(newConversationButton).toHaveClass(
      "agent-gui-workbench-header__icon-button"
    );
    expect(newConversationButton).toHaveAttribute("data-size", "icon-sm");
    expect(newConversationButton.querySelector("svg")).toHaveClass(
      "agent-gui-workbench-header__icon"
    );
    const collapsedSessionTitle = screen
      .getByText("Current session title")
      .closest(".agent-gui-workbench-header__session-title");
    expect(collapsedSessionTitle).not.toBeNull();
    expect(screen.getByTestId("agent-gui-window-session-icon")).toHaveAttribute(
      "src",
      "tutti-asset://agent/codex-session.png"
    );
    expect(screen.getByText("Current session title")).toHaveClass(
      "agent-gui-workbench-header__title-text"
    );
    expect(screen.queryByTestId("agent-gui-window-detail-title")).toBeNull();

    fireEvent.click(screen.getByTestId("agent-gui-window-close"));
    fireEvent.click(screen.getByTestId("agent-gui-window-minimize"));
    fireEvent.click(screen.getByTestId("agent-gui-window-toggle-display-mode"));

    expect(close).toHaveBeenCalledTimes(1);
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(toggleDisplayMode).toHaveBeenCalledTimes(1);
  });

  it("refreshes the workbench header when the canonical session title changes", () => {
    const sessionEngine = createTestAgentSessionEngine("workspace-1");
    sessionEngine.dispatch({
      type: "activation/requested",
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      clientSubmitId: "submit-1",
      cwd: "/workspace",
      expiresAtUnixMs: Date.now() + 45_000,
      mode: "new",
      requestedAtUnixMs: 1,
      requestId: "activation-1",
      optimisticTitle: "test1",
      workspaceId: "workspace-1"
    });
    sessionEngine.dispatch({
      session: createWorkbenchSession("", 1),
      type: "session/upserted"
    });
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      sessionEngine,
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: {
          agentTargetId: "local:codex",
          conversationRailCollapsed: false,
          lastActiveAgentSessionId: "session-1"
        },
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Codex"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    expect(
      screen.getByTestId("agent-gui-window-detail-title")
    ).toHaveTextContent("test1");
    expect(
      screen.getByTestId("agent-gui-window-detail-title-icon")
    ).toBeInTheDocument();

    act(() => {
      sessionEngine.dispatch({
        session: createWorkbenchSession("Updated session title", 2),
        type: "session/upserted"
      });
    });

    expect(
      screen.getByTestId("agent-gui-window-detail-title")
    ).toHaveTextContent("Updated session title");
    expect(screen.queryByText("test1")).toBeNull();
  });

  it("keeps unified header chrome free of provider window titles", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      unifiedDockIconUrl: "app://icons/agent-unified.png",
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: null,
        externalWorkspaceState: null,
        instanceId: "agent-gui:claude-code:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Agent"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    expect(screen.getByText("Agent")).toHaveClass(
      "agent-gui-workbench-header__agent-name"
    );
    expect(screen.queryByText("Claude Code")).toBeNull();
    expect(screen.queryByTestId("agent-gui-window-session-icon")).toBeNull();
    expect(
      screen.queryByTestId("agent-gui-window-detail-title-icon")
    ).toBeNull();
    expect(screen.queryByTestId("agent-gui-window-detail-title")).toBeNull();
  });

  it("keys direct-manipulation header renders by visible rail layout", () => {
    const definition = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    }).nodes?.[0];
    const getKey = definition?.getHeaderFrameRenderKey;
    const createContext = (input: { isDragging?: boolean; width: number }) =>
      ({
        externalNodeState: {
          conversationRailCollapsed: false,
          conversationRailWidthPx: 520
        },
        isDragging: input.isDragging === true,
        node: {
          data: { runtimeNodeState: null },
          frame: { height: 560, width: input.width, x: 0, y: 0 }
        }
      }) as never;

    expect(getKey?.(createContext({ isDragging: true, width: 700 }))).toBe(
      "dragging"
    );
    expect(getKey?.(createContext({ width: 600 }))).toBe("collapsed");
    expect(getKey?.(createContext({ width: 650 }))).toBe("expanded:420");
    expect(getKey?.(createContext({ width: 700 }))).toBe("expanded:470");
  });

  it("renders the expanded workbench header as a rail titlebar plus detail title", () => {
    const openDetachedWindow = vi.fn();
    const contribution = createTestAgentGuiWorkbenchContribution({
      copy: {
        sessionMenu: {
          copyAsMarkdown: "Copy as Markdown",
          copyAsReference: "Copy as reference",
          moreSessionActions: "More session actions",
          renameSession: "Rename session"
        }
      },
      onOpenDetachedWindow: openDetachedWindow,
      renderBody: () => null,
      resolveDockPopupIdentity: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? {
              iconUrl: "tutti-asset://agent/codex-session.png",
              title: "Current session title"
            }
          : null,
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: createElement(
          "button",
          { type: "button" },
          "window actions"
        ),
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: {
          agentTargetId: "local:codex",
          conversationRailCollapsed: false,
          conversationRailWidthPx: 360,
          lastActiveAgentSessionId: "session-1"
        },
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Codex"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    const header = document.querySelector(
      '[data-agent-gui-workbench-header="true"]'
    );
    const primary = document.querySelector(
      "[data-agent-gui-workbench-header-primary='true']"
    );

    expect(header).toHaveClass("agent-gui-workbench-header");
    expect(header).toHaveAttribute(
      "data-agent-gui-workbench-header-collapsed",
      "false"
    );
    expect(header).toHaveStyle({
      "--agent-gui-workbench-header-rail-width": `${
        360 + agentGuiWorkbenchProviderRailWidthPx
      }px`
    });
    expect(primary).toHaveClass("agent-gui-workbench-header__primary");
    expect(screen.getByText("Agent")).toHaveClass(
      "agent-gui-workbench-header__agent-name"
    );
    expect(screen.queryByText("Codex")).toBeNull();
    expect(
      screen.getByTestId("agent-gui-toggle-conversation-rail")
    ).toHaveClass("agent-gui-workbench-header__rail-toggle");
    const detachedWindowButton = screen.getByRole("button", {
      name: agentGuiWorkbenchDefaultCopy.openDetachedWindow
    });
    expect(detachedWindowButton).toHaveClass(
      "agent-gui-workbench-header__detached-window"
    );
    expect(screen.queryByTestId("agent-gui-window-session-icon")).toBeNull();
    expect(
      screen.getByTestId("agent-gui-window-detail-title")
    ).toHaveTextContent("Current session title");
    expect(
      screen.getByTestId("agent-gui-window-detail-title-icon")
    ).toHaveAttribute("src", "tutti-asset://agent/codex-session.png");
    const sessionMenuTrigger = screen.getByTestId(
      "agent-gui-session-menu-trigger"
    );
    expect(
      screen.getByTestId("agent-gui-window-detail-title")
    ).toContainElement(sessionMenuTrigger);
    expect(
      screen.queryByRole("button", { name: "window actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: agentGuiWorkbenchDefaultCopy.newConversation
      })
    ).not.toBeInTheDocument();

    fireEvent.click(detachedWindowButton);
    expect(openDetachedWindow).toHaveBeenCalledWith({
      agentSessionId: "session-1",
      agentTargetId: "local:codex",
      provider: "codex",
      workspaceId: "workspace-1"
    });
  });

  it("aligns the expanded unified header controls with the provider and conversation rails", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      workspaceId: "workspace-1"
    });

    render(
      contribution.nodes?.[0]?.renderHeader?.({
        activation: null,
        defaultActions: null,
        displayMode: "floating",
        dragHandleProps: {},
        externalNodeState: {
          conversationRailCollapsed: false,
          conversationRailWidthPx: 360,
          lastActiveAgentSessionId: null
        },
        externalWorkspaceState: null,
        instanceId: "agent-gui:codex:panel:test-1",
        instanceKey: null,
        isFocused: true,
        node: {
          data: {
            dockEntryId: agentGuiWorkbenchUnifiedDockEntryId(),
            runtimeNodeState: null
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui-node-1",
          title: "Agent"
        },
        surfaceSize: { height: 800, width: 1200 },
        windowActions: {
          applyQuickLayout: () => {},
          close: () => {},
          focus: () => {},
          minimize: () => {},
          resize: () => {},
          toggleDisplayMode: () => {}
        }
      } as never) ?? null
    );

    expect(
      document.querySelector('[data-agent-gui-workbench-header="true"]')
    ).toHaveStyle({
      "--agent-gui-workbench-header-rail-width": `${
        360 + agentGuiWorkbenchProviderRailWidthPx
      }px`
    });
  });

  it("keeps the shared workbench header continuous with the conversation body", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).not.toContain("--agent-gui-workbench-header-divider");
    expect(css).not.toContain(
      '.agent-gui-workbench-header[data-agent-gui-workbench-header-has-session="true"]::after'
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-collapsed="true"\]\s*\.agent-gui-workbench-header__primary\s*{[^}]*grid-column:\s*1 \/ -1;[^}]*width:\s*100%;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-collapsed="true"\]\s*\.agent-gui-workbench-header__secondary-accessory\s*{[^}]*padding-right:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__detached-window\s*{\s*margin-left:\s*auto;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-collapsed="true"\]\s*\.agent-gui-workbench-header__detached-window\s*{[^}]*margin-left:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__detached-window\s*\+\s*\.agent-gui-workbench-header__rail-toggle\s*{[^}]*margin-left:\s*-4px;/s
    );
  });

  it("keeps rich workbench titles on one aligned line", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title\s*{[^}]*display:\s*block;[^}]*width:\s*max-content;[^}]*max-width:\s*calc\(100% - 36px\);[^}]*height:\s*24px;[^}]*flex:\s*0 1 auto;[^}]*overflow:\s*hidden;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title > div,\s*\.agent-gui-workbench-header__rich-title \.ProseMirror\s*{[^}]*width:\s*100%;[^}]*height:\s*24px;[^}]*overflow:\s*visible;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title p\s*{[^}]*display:\s*flex;[^}]*width:\s*max-content;[^}]*min-width:\s*100%;[^}]*height:\s*24px;[^}]*align-items:\s*center;[^}]*overflow:\s*visible;[^}]*overflow-wrap:\s*normal;[^}]*line-height:\s*24px;[^}]*white-space:\s*nowrap;[^}]*word-break:\s*normal;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title \.agent-rich-text-mention-node,\s*\.agent-gui-workbench-header__rich-title \.tsh-agent-object-token--file,\s*\.agent-gui-workbench-header__rich-title \.tsh-agent-object-token--entity,\s*\.agent-gui-workbench-header__rich-title \[data-slot="mention-pill"\]\s*{[^}]*top:\s*0;[^}]*align-items:\s*center;[^}]*transform:\s*none;[^}]*vertical-align:\s*middle;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title\s+\.agent-rich-text-mention-node\[data-agent-custom-mention="true"\]\s*{[^}]*display:\s*inline-flex;[^}]*height:\s*24px;[^}]*align-items:\s*center;[^}]*transform:\s*translateY\(-1\.5px\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title \.tsh-agent-object-token--file\s*{[^}]*height:\s*24px;[^}]*min-height:\s*24px;[^}]*line-height:\s*24px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rich-title\s+\.tsh-agent-object-token--file\s+\.tsh-agent-object-token__main\s*{[^}]*transform:\s*translateY\(-1\.25px\);/s
    );
  });

  it("keeps shared tool actions pinned to the header edge when the conversation rail collapses", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-tool-sidebar="true"\]\[data-agent-gui-workbench-header-collapsed="true"\]\s*\.agent-gui-workbench-header__primary\s*\{[^}]*width:\s*100%;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-tool-sidebar="true"\]\s*\.agent-gui-workbench-header__secondary-accessory\s*\{[^}]*padding-right:\s*0;/s
    );
  });

  it("anchors the shared tool header to the same edge as the body panel", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-workbench-header\[data-agent-gui-workbench-header-tool-sidebar="true"\]\s*\.agent-gui-workbench-header__secondary-accessory:has\(\s*\[data-agent-tool-sidebar-header="true"\]\s*\)\s*\{[^}]*position:\s*absolute;[^}]*top:\s*0;[^}]*right:\s*0;[^}]*margin-left:\s*0;/s
    );
  });

  it("keeps image previews and overlay headers above Agent panels", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.tsh-zoom-dialog\[data-rmiz-modal\]\s*{[^}]*z-index:\s*var\(--z-dialog\);/s
    );
    expect(css).toMatch(
      /\.workbench-window\[data-window-header-layout="overlay"\]\s*\.workbench-window__header\s*{[^}]*z-index:\s*calc\(var\(--z-panel\) \+ 1\);/s
    );
  });

  it("uses one explicit overlay presentation state instead of surface-mode selectors", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.workbench-window\[data-window-header-layout="overlay"\]\s*{/s
    );
    expect(css).not.toMatch(
      /\[data-agent-gui-standalone-window="true"\][^{,]*,\s*\.workbench-window\[data-window-header-layout="overlay"\]/
    );
    expect(css).not.toMatch(/\.workbench-window:has\(/);
  });

  it("keeps a lone provider settings footer clear of the window edge", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-config-footer:last-child\s*\{[^}]*padding-bottom:\s*12px;/s
    );
  });

  it("separates the injected provider rail footer from settings", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-sidebar-footer\s*\+\s*\.agent-gui-node__provider-rail-config-footer\s*\{[^}]*margin-top:\s*8px;/s
    );
  });

  it("lowers composer plain text without moving mention fields", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-prompt-input-area\s+textarea,\s*\.agent-gui-node__composer\[data-layout="dock"\]\s+\.agent-gui-node__composer-textarea\s*{[^}]*padding-top:\s*12px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s+p:not\(\.agent-rich-text-placeholder-node\):not\(:empty\)\s*{[^}]*top:\s*0;[^}]*line-height:\s*var\(--agent-gui-composer-text-line-height\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s+p:not\(\.agent-rich-text-placeholder-node\):not\(:empty\)\s+\.agent-rich-text-mention-node\s*{[^}]*transform:\s*translateY\(-2px\);/s
    );
  });

  it("keeps slash mention fields aligned and transparent by default", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\[data-agent-mention-kind="skill"\]\.tsh-agent-object-token--entity\s+\.tsh-agent-object-token__main,\s*\[data-agent-mention-kind="capability"\]\.tsh-agent-object-token--entity\s+\.tsh-agent-object-token__main\s*{[^}]*background:\s*transparent;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s+\[data-agent-mention-kind="skill"\]\.tsh-agent-object-token--entity\s+\.tsh-agent-object-token__main,\s*\.agent-gui-node__composer-textarea\s+\[data-agent-mention-kind="capability"\]\.tsh-agent-object-token--entity\s+\.tsh-agent-object-token__main\s*{[^}]*transform:\s*translateY\(-2px\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s+\[data-agent-file-mention="true"\]\.tsh-agent-object-token:hover\s*{[^}]*background:\s*color-mix\(in srgb, currentColor 16%, transparent\);/s
    );
  });

  it("lets compact custom mention chips keep the normal composer caret height", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__composer-textarea\s+\.agent-rich-text-mention-node\[data-agent-custom-mention="true"\]\s*\{[^}]*height:\s*auto;[^}]*min-height:\s*0;[^}]*line-height:\s*inherit;/s
    );
  });

  it("keeps interactive feedback scrolling above the send button", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-feedback-composer\s*{[^}]*min-height:\s*80px;[^}]*overflow:\s*hidden;[^}]*padding-bottom:\s*44px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-feedback-composer\s+\.agent-gui-conversation__interactive-prompt-textarea\s*{[^}]*min-height:\s*36px;[^}]*border:\s*0;[^}]*padding:\s*9px 10px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-feedback-send-button\s+\.agent-gui-conversation__interactive-option-spinner\s*{[^}]*position:\s*static;[^}]*top:\s*auto;[^}]*right:\s*auto;[^}]*transform:\s*none;/s
    );
  });

  it("keeps provider manager drag hit boxes stable while previewing insertion", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).not.toMatch(
      /\.agent-gui-provider-manager-tile\[data-drag-over="(?:before|after)"\]\s*\{[^}]*margin-/s
    );
    expect(css).toMatch(
      /\.agent-gui-provider-manager-tile\[data-drag-over="before"\]\s*>\s*:not\(\.agent-gui-provider-manager-drop-indicator\)\s*\{[^}]*translate:\s*8px 0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-provider-manager-tile\[data-drag-over="after"\]\s*>\s*:not\(\.agent-gui-provider-manager-drop-indicator\)\s*\{[^}]*translate:\s*-8px 0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-provider-manager-tile\[data-editing="true"\]\[data-drag-active="true"\]\s*\{[^}]*animation:\s*none;/s
    );
  });

  it("anchors ready and gated empty homes to the same fixed frame", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");
    const providerGateRule =
      css.match(/\.agent-gui-node__empty-provider-gate\s*\{[^}]*\}/s)?.[0] ??
      "";

    expect(css).toMatch(
      /\.agent-gui-node__empty-hero\s*\{[^}]*--agent-gui-empty-hero-anchor-block-size:\s*398px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-body\s*\{[^}]*block-size:\s*var\(--agent-gui-empty-hero-anchor-block-size\);[^}]*align-content:\s*start;/s
    );
    expect(providerGateRule).not.toMatch(/(?:min-)?(?:block-size|height):/);
  });

  it("scales the empty-home vinyl carousel down for short AgentGUI windows", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-carousel-layer\s*\{[^}]*--agent-gui-hero-carousel-scale:\s*0\.8;[^}]*min-width:\s*320px;[^}]*transform:\s*translateX\(-50%\)\s*scale\(var\(--agent-gui-hero-carousel-scale\)\);/s
    );
    expect(css).toMatch(
      /@media\s*\(max-height:\s*639px\)\s*\{\s*\.agent-gui-node__empty-hero-carousel-layer\s*\{[^}]*--agent-gui-hero-carousel-scale:\s*0\.64;[^}]*top:\s*calc\(\s*var\(--agent-gui-hero-carousel-slot-top,\s*calc\(50%\s*-\s*210px\)\)\s*-\s*16px\s*\);/s
    );
  });

  it("scopes composer textarea resets to the primary prompt input", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).not.toMatch(
      /\.agent-gui-node__composer(?:\[data-layout="dock"\])?\s+textarea/
    );
    expect(css).toMatch(
      /\.agent-gui-node__composer-prompt-input-area\s+textarea,\s*\.agent-gui-node__composer-textarea\s*\{[^}]*border:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-conversation__interactive-prompt-textarea\s*\{[^}]*border:\s*1px solid var\(--line-2\);/s
    );
  });
});

function createWorkbenchSession(title: string, updatedAtUnixMs: number) {
  return normalizeAgentActivitySession({
    activeTurnId: null,
    agentSessionId: "session-1",
    agentTargetId: "local:codex",
    cwd: "/workspace",
    latestTurnInteractions: [],
    pendingInteractions: [],
    provider: "codex",
    title,
    updatedAtUnixMs,
    workspaceId: "workspace-1"
  });
}
