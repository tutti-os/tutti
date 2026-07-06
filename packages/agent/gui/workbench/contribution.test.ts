import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import {
  Children,
  createElement,
  isValidElement,
  type ReactElement,
  type ReactNode
} from "react";
import { agentGuiDockIconUrls } from "../dockIcons.ts";
import { createLocalAgentGUIProviderTarget } from "../providerTargets.ts";
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
    "renderMinimizedPreview"
  > &
    Partial<
      Pick<
        Parameters<typeof createAgentGuiWorkbenchContribution>[0],
        "renderMinimizedPreview"
      >
    >
) {
  return createAgentGuiWorkbenchContribution({
    renderMinimizedPreview: () => null,
    ...input
  });
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
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    const entries = buildAgentGuiDockEntries({
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        "claude-code": true,
        codex: false
      },
      targets: [createLocalAgentGUIProviderTarget("codex"), claudeTarget]
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(agentGuiWorkbenchUnifiedDockEntryId());
    expect(entries[0]?.label).toBe("Agent");
    expect(entries[0]?.launchPayload).toEqual({
      agentTargetId: "local:claude-code",
      provider: "claude-code",
      providerTargetId: "local:claude-code",
      providerTargetRef: claudeTarget.ref
    });
  });

  it("uses the unified icon URL for unified dock entries", () => {
    const entries = buildAgentGuiDockEntries({
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        codex: true
      },
      targets: [createLocalAgentGUIProviderTarget("codex")],
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
      ...createLocalAgentGUIProviderTarget("claude-code"),
      agentTargetId: "disabled-claude",
      disabled: true,
      targetId: "disabled-claude"
    };
    const enabledClaudeTarget = {
      ...createLocalAgentGUIProviderTarget("claude-code"),
      agentTargetId: "daemon-claude",
      targetId: "daemon-claude"
    };
    const entries = buildAgentGuiDockEntries({
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        "claude-code": true,
        codex: false
      },
      targets: [
        createLocalAgentGUIProviderTarget("codex"),
        disabledClaudeTarget,
        enabledClaudeTarget
      ]
    });

    expect(entries[0]?.launchPayload).toEqual({
      agentTargetId: "daemon-claude",
      provider: "claude-code",
      providerTargetId: "daemon-claude",
      providerTargetRef: enabledClaudeTarget.ref
    });
  });

  it("uses host target order for an available default provider", () => {
    const daemonCodexTarget = {
      ...createLocalAgentGUIProviderTarget("codex"),
      agentTargetId: "daemon-codex",
      targetId: "daemon-codex"
    };
    const localCodexTarget = createLocalAgentGUIProviderTarget("codex");
    const entries = buildAgentGuiDockEntries({
      defaultProvider: "codex",
      label: "Agent",
      providerAvailability: {
        codex: true
      },
      targets: [daemonCodexTarget, localCodexTarget]
    });

    expect(entries[0]?.launchPayload).toEqual({
      agentTargetId: "daemon-codex",
      provider: "codex",
      providerTargetId: "daemon-codex",
      providerTargetRef: daemonCodexTarget.ref
    });
  });

  it("matches unified dock nodes across provider-specific and historical agent GUI identities", () => {
    const [entry] = buildAgentGuiDockEntries({
      providerAvailability: {},
      targets: []
    });

    expect(
      entry?.matchNode?.({
        data: {
          instanceId: "agent-gui:codex:panel:test-1",
          typeId: agentGuiWorkbenchTypeId
        }
      } as never)
    ).toBe(true);
    expect(
      entry?.matchNode?.({
        data: {
          instanceId: "agent-gui:claude-code:session:session-1",
          typeId: agentGuiWorkbenchTypeId
        }
      } as never)
    ).toBe(true);
    expect(
      entry?.matchNode?.({
        data: {
          dockEntryId: "agent-gui",
          instanceId: "agent-gui",
          typeId: agentGuiWorkbenchTypeId
        }
      } as never)
    ).toBe(true);
    expect(
      entry?.matchNode?.({
        data: {
          instanceId: "agent-gui:gemini:panel:test-1",
          typeId: agentGuiWorkbenchTypeId
        }
      } as never)
    ).toBe(false);
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
    expect(launchResult?.instanceId).toContain("agent-gui:claude-code:panel:");
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

  it("resolves unified empty dock launches lazily from current provider availability", () => {
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    const contribution = createTestAgentGuiWorkbenchContribution({
      defaultProvider: "codex",
      providerAvailability: {},
      providerTargets: [
        createLocalAgentGUIProviderTarget("codex"),
        claudeTarget
      ],
      renderBody: () => null,
      resolveDockLaunchPayload: () => ({
        agentTargetId: claudeTarget.agentTargetId,
        provider: "claude-code",
        providerTargetId: claudeTarget.targetId,
        providerTargetRef: claudeTarget.ref
      }),
      workspaceId: "workspace-1"
    });
    const [dockEntry] = contribution.dockEntries ?? [];

    expect(dockEntry?.launchPayload).toMatchObject({
      provider: "codex"
    });

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
      title: "Agent"
    });
    expect(launchResult?.instanceId).toBe(
      "agent-gui:claude-code:target:local%3Aclaude-code"
    );
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toMatchObject({
      agentTargetId: "local:claude-code"
    });
  });

  it("seeds unified launch descriptor target state without changing provider identity", () => {
    const claudeTarget = createLocalAgentGUIProviderTarget("claude-code");
    const contribution = createTestAgentGuiWorkbenchContribution({
      defaultProviderTargetId: claudeTarget.targetId,
      providerTargets: [
        createLocalAgentGUIProviderTarget("codex"),
        claudeTarget
      ],
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
      title: "Agent"
    });
    expect(launchResult?.instanceId).toBe(
      "agent-gui:claude-code:target:local%3Aclaude-code"
    );
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

  it("does not seed fallback target state while provider targets are loading", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      providerTargets: [],
      providerTargetsLoading: true,
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
      title: "Agent"
    });
    expect(
      contribution.externalStateSource?.getSnapshotNodeState?.({
        instanceId: launchResult?.instanceId ?? "",
        typeId: agentGuiWorkbenchTypeId
      } as never)
    ).toBeNull();
  });

  it("does not seed fallback target state when provider targets are explicitly empty", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      providerTargets: [],
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
      title: "Agent"
    });
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
      agentGuiDockIconUrls.nexight,
      agentGuiDockIconUrls.hermes
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
      agentGuiDockIconUrls.nexight,
      agentGuiDockIconUrls.hermes
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

  it("opens at 80 percent width and 90 percent height of the visible workbench area", () => {
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
      width: 1152,
      x: 144,
      y: 91
    });
  });

  it("keeps the 80 percent width on compact visible workbench areas", () => {
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
      width: 784,
      x: 98,
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
      width: 1152,
      x: 144,
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
      payload: null,
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
        width: 784,
        x: 98,
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

    expect(existingLaunch?.instanceId).toContain("agent-gui:codex:panel:");
    expect(newWindowLaunch?.instanceId).toContain("agent-gui:codex:panel:");
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

    expect(firstLaunch?.instanceId).toContain("agent-gui:codex:panel:");
    expect(relaunch?.instanceId).toBe(firstLaunch?.instanceId);
    expect(firstLaunch?.preserveExistingNodeFrame).not.toBe(true);
    expect(relaunch?.preserveExistingNodeFrame).toBe(true);
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
    expect(relaunch?.instanceId).toContain("agent-gui:codex:panel:");
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
        width: 784,
        x: 98,
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
        dockEntryId: agentGuiWorkbenchTypeId,
        instanceId: "agent-gui:codex:panel:test-1",
        typeId: agentGuiWorkbenchTypeId
      },
      id: "agent-gui:agent-gui:codex:panel:test-1",
      title: "Codex"
    };

    expect(dockEntry?.matchNode?.(node as never)).toBe(true);
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

  it("uses the host preview renderer for agent GUI dock popup previews", async () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      renderPreview: () => "preview",
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });
    const dockEntry = contribution.dockEntries?.find(
      (entry) => entry.id === agentGuiWorkbenchUnifiedDockEntryId()
    );
    expect(dockEntry).toBeDefined();

    const node = {
      data: {
        dockEntryId: agentGuiWorkbenchTypeId,
        instanceId: "agent-gui:codex:panel:test-1",
        typeId: agentGuiWorkbenchTypeId
      },
      displayMode: "floating",
      frame: { height: 560, width: 1040, x: 0, y: 0 },
      id: "agent-gui:agent-gui:codex:panel:test-1",
      isMinimized: false,
      restoreFrame: null,
      title: "Codex"
    };

    const preview =
      dockEntry?.providePopupItemPreview?.({
        externalNodeState: {
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Stale session title"
        },
        externalWorkspaceState: null,
        host: {} as never,
        isFocused: false,
        isMinimized: false,
        node: node as never
      }) ?? null;
    expect(preview?.kind).toBe("component");
    expect(preview?.revision).toContain("Current session title");
    expect(preview?.revision).not.toContain("Stale session title");
  });

  it("uses the host minimized preview renderer for agent GUI minimized slots", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      renderMinimizedPreview: () => "minimized-preview",
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
          : null,
      workspaceId: "workspace-1"
    });
    const minimizedDock = contribution.nodes?.[0]?.window?.minimizedDock;
    expect(minimizedDock?.kind).toBe("component");
    if (minimizedDock?.kind !== "component") {
      throw new Error("expected component minimized preview");
    }

    const preview =
      minimizedDock.providePreview({
        externalNodeState: {
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Stale session title"
        },
        externalWorkspaceState: null,
        host: {} as never,
        isFocused: false,
        isMinimized: true,
        node: {
          data: {
            dockEntryId: agentGuiWorkbenchTypeId,
            instanceId: "agent-gui:codex:panel:test-1",
            typeId: agentGuiWorkbenchTypeId
          },
          displayMode: "floating",
          frame: { height: 560, width: 1040, x: 0, y: 0 },
          id: "agent-gui:agent-gui:codex:panel:test-1",
          isMinimized: true,
          restoreFrame: null,
          title: "Codex"
        } as never
      }) ?? null;

    expect(preview?.kind).toBe("component");
    if (preview?.kind !== "component") {
      throw new Error("expected component preview content");
    }
    expect(preview.element).toBe("minimized-preview");
    expect(preview.revision).toContain("Current session title");
    expect(preview.revision).not.toContain("Stale session title");
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
              title: null
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
          lastActiveAgentSessionId: "session-1",
          lastActiveConversationTitle: "Current session title"
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
  });

  it("renders the expanded workbench header as a rail titlebar plus detail title", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
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
    expect(screen.queryByTestId("agent-gui-window-session-icon")).toBeNull();
    expect(
      screen.getByTestId("agent-gui-window-detail-title")
    ).toHaveTextContent("Current session title");
    expect(
      screen.queryByRole("button", { name: "window actions" })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: agentGuiWorkbenchDefaultCopy.newConversation
      })
    ).not.toBeInTheDocument();
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
});
