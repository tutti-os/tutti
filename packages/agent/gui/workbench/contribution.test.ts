import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  agentGuiWorkbenchUnifiedDockEntryId,
  agentGuiWorkbenchTypeId
} from "./launch.ts";

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

  it("uses the launchpad tile style for unified dock entries", () => {
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
        className: "agent-gui-workbench-dock-icon"
      }
    });
    expect(readDockEntryIconImageSrcs(entries[0]?.icon)).toEqual([
      agentGuiDockIconUrls.codex,
      agentGuiDockIconUrls["claude-code"],
      agentGuiDockIconUrls.nexight,
      agentGuiDockIconUrls.hermes
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
      instanceId: "agent-gui:claude-code:session:session-claude-1",
      title: "Agent"
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

  it("renders the workbench header title without an agent icon", () => {
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
    expect(screen.queryByTestId("agent-gui-window-title-icon")).toBeNull();
  });

  it("opens at the widened default width and 88.6 percent height when the workbench area can fit the default frame", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 708, width: 1448, x: 140, y: 48 },
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
          height: 960,
          width: 1600
        }
      }
    });

    expect(frame).toEqual({
      height: 734,
      width: 1448,
      x: 140,
      y: 48
    });
  });

  it("opens at 90 percent of the visible workbench area when the window cannot fit the default frame", () => {
    const frame = resolveAgentGuiWorkbenchDefaultLaunchFrame({
      frame: { height: 708, width: 1448, x: 140, y: 48 },
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
      frame: { height: 708, width: 1448, x: 140, y: 48 },
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
          width: 1600
        }
      }
    });

    expect(frame).toEqual({
      height: 554,
      width: 1448,
      x: 76,
      y: 83
    });
  });

  it("preserves the 90 percent visible-area frame during compact launches", () => {
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

    expect(existingLaunch?.instanceId).toBe(
      "agent-gui:codex:session:session-1"
    );
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

    expect(firstLaunch?.instanceId).toBe("agent-gui:codex:session:session-1");
    expect(relaunch?.instanceId).toBe(firstLaunch?.instanceId);
    expect(firstLaunch?.preserveExistingNodeFrame).not.toBe(true);
    expect(relaunch?.preserveExistingNodeFrame).toBe(true);
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

  it("keeps the app title separate from the active session title when collapsed", () => {
    const contribution = createTestAgentGuiWorkbenchContribution({
      renderBody: () => null,
      resolveDockPopupTitle: (state) =>
        state?.lastActiveAgentSessionId === "session-1"
          ? "Current session title"
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
    expect(primary).toContainElement(screen.getByText("Agent"));
    expect(screen.queryByTestId("agent-gui-window-title-icon")).toBeNull();
    expect(screen.getByText("Agent")).toBeInTheDocument();
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

  it("uses the generic Agent title with the unified icon for unified header chrome", () => {
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
    expect(screen.queryByTestId("agent-gui-window-title-icon")).toBeNull();
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
    expect(screen.getByText("Agent")).toBeInTheDocument();
    expect(screen.queryByText("Codex")).toBeNull();
    expect(
      screen.getByTestId("agent-gui-toggle-conversation-rail")
    ).toHaveClass("agent-gui-workbench-header__rail-toggle");
    expect(screen.queryByTestId("agent-gui-window-title-icon")).toBeNull();
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

  it("caps workbench header conversation titles with 32px right padding", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /--agent-gui-workbench-header-title-max-width:\s*calc\(100%\s*-\s*32px\);/
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__session-title\s*{[^}]*max-width:\s*min\(100%,\s*var\(--agent-gui-workbench-header-title-max-width\)\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__detail-title\s*{[^}]*max-width:\s*min\(100%,\s*var\(--agent-gui-workbench-header-title-max-width\)\)/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__title-text\s*{[^}]*overflow:\s*hidden[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/s
    );
  });

  it("hides the workbench header rail toggle while the node render fallback is visible", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.workbench-window:has\(\[data-workbench-node-render-error="true"\]\)\s+\.agent-gui-workbench-header__rail-toggle\s*{[^}]*display:\s*none !important;/s
    );
  });

  it("owns the grid-style tiled dock icon styles", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.agent-gui-workbench-dock-icon\s*{[^}]*display:\s*grid;[^}]*width:\s*44px;[^}]*height:\s*44px;[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);[^}]*gap:\s*2px;[^}]*padding:\s*3px;[^}]*border:\s*1px solid var\(--agent-gui-workbench-dock-icon-border,\s*var\(--line-1\)\);[^}]*border-radius:\s*8px;[^}]*background:\s*var\(\s*--agent-gui-workbench-dock-icon-bg,\s*var\(--transparency-block\)\s*\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-dock-icon__tile\s*{[^}]*display:\s*block;[^}]*overflow:\s*hidden;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*border-radius:\s*6px;[^}]*background:\s*transparent;/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-workbench-dock-icon__tile:nth-child\(1\)\s*{[^}]*transform:\s*translateX\(-50%\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-dock-icon__tile\s*>\s*img\s*{[^}]*object-fit:\s*contain;[^}]*object-position:\s*center;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-launchpad-icon\s*{[^}]*display:\s*grid;[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*grid-template-columns:\s*repeat\(2,\s*1fr\);[^}]*gap:\s*2px;[^}]*padding:\s*1px;[^}]*border:\s*0;[^}]*border-radius:\s*6px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-launchpad-item\s*{[^}]*display:\s*grid;[^}]*min-width:\s*0;[^}]*min-height:\s*0;[^}]*place-items:\s*center;[^}]*overflow:\s*hidden;[^}]*background:\s*var\(--background-fronted\);[^}]*border-radius:\s*4px;/s
    );
    expect(css).not.toMatch(
      /\.agent-gui-node__provider-rail-launchpad-item:nth-child\(1\)\s*{[^}]*transform:\s*translateX\(-50%\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-launchpad-icon\s*{[^}]*width:\s*54px;[^}]*height:\s*54px;[^}]*border-color:\s*var\(--tutti-purple\);[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--transparency-block\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-launchpad-icon\s+\.agent-gui-node__provider-rail-launchpad-icon\s*{[^}]*width:\s*48px;[^}]*height:\s*48px;[^}]*gap:\s*3px;[^}]*padding:\s*1px;[^}]*border-radius:\s*8px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__empty-hero-launchpad-icon\s+\.agent-gui-node__provider-rail-launchpad-item\s*{[^}]*border-radius:\s*6px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-node__provider-rail-tile\[data-selected="true"\]\s+\.agent-gui-node__provider-rail-avatar:has\(\s*>\s*\.agent-gui-node__provider-rail-launchpad-icon\s*\),\s*\.agent-gui-node__provider-rail-tile\[data-selected="true"\]:hover:not\(:disabled\)\s+\.agent-gui-node__provider-rail-avatar:has\(\s*>\s*\.agent-gui-node__provider-rail-launchpad-icon\s*\)\s*{[^}]*border-color:\s*var\(--tutti-purple\);[^}]*background:\s*var\(--transparency-block\);/s
    );
  });

  it("uses the dark scrim value for zoom image modal overlays", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.tsh-zoom-dialog\s+\[data-rmiz-modal-overlay="visible"\]\s*{[^}]*background:\s*rgb\(0 0 0 \/ 60%\);/s
    );
    expect(css).toMatch(
      /\.tsh-zoom-dialog\s+\[data-rmiz-modal-overlay="hidden"\]\s*{[^}]*background:\s*rgb\(0 0 0 \/ 0%\);/s
    );
    expect(css).not.toMatch(
      /\.tsh-zoom-dialog\s+\[data-rmiz-modal-overlay="visible"\]\s*{[^}]*background:\s*color-mix\(in srgb,\s*var\(--background-panel\)/s
    );
  });

  it("renders zoom image modal action buttons as fully rounded controls", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.tsh-zoom-dialog__icon-button,\s*\.tsh-zoom-dialog__image-actions button\s*{[^}]*width:\s*32px;[^}]*height:\s*32px;[^}]*border-radius:\s*999px;/s
    );
  });

  it("keeps zoom image modal zoom controls aligned with action buttons", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(
      /\.tsh-zoom-dialog__zoom-controls\s*{[^}]*height:\s*32px;[^}]*padding:\s*0 2px;[^}]*border-radius:\s*999px;[^}]*background:\s*var\(--background-fronted\);/s
    );
    expect(css).toMatch(
      /\.tsh-zoom-dialog__zoom-controls button\s*{[^}]*width:\s*28px;[^}]*height:\s*28px;[^}]*border-radius:\s*999px;/s
    );
    expect(css).toMatch(
      /\.tsh-zoom-dialog__zoom-controls span\s*{[^}]*line-height:\s*28px;[^}]*color:\s*var\(--text-primary\);/s
    );
  });

  it("keeps the traffic light group aligned with the agent identity", () => {
    const css = readFileSync(resolve("app/renderer/agentactivity.css"), "utf8");

    expect(css).toMatch(/--agent-gui-workbench-header-padding-x:\s*16px;/);
    expect(css).toMatch(/--agent-gui-workbench-header-primary-gap:\s*12px;/);
    expect(css).toMatch(
      /--agent-gui-workbench-header-traffic-light-size:\s*12px;/
    );
    expect(css).toMatch(
      /--agent-gui-workbench-header-traffic-light-hit-area-size:\s*20px;/
    );
    expect(css).toMatch(
      /--agent-gui-workbench-header-traffic-light-gap:\s*8px;/
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__primary\s*{[^}]*padding:\s*0\s+var\(--agent-gui-workbench-header-padding-x\);/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__primary\s*{[^}]*gap:\s*var\(--agent-gui-workbench-header-primary-gap\);/s
    );
    const headerPrimaryCss = css.match(
      /\.agent-gui-workbench-header__primary\s*{(?<body>[^}]*)}/s
    )?.groups?.body;
    expect(headerPrimaryCss).toBeDefined();
    expect(headerPrimaryCss).not.toMatch(/border-right:/);
    expect(css).toMatch(
      /\.agent-gui-node__rail-panel\s*{[^}]*border-right:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-lights\s*{[^}]*margin-right:\s*0;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-light\s*{[^}]*width:\s*var\(--agent-gui-workbench-header-traffic-light-hit-area-size\);[^}]*height:\s*var\(--agent-gui-workbench-header-traffic-light-hit-area-size\);[^}]*margin:\s*calc\(/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-light\s*{[^}]*cursor:\s*pointer;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-light\s*{[^}]*transition:\s*opacity 160ms ease;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-light::before\s*{[^}]*inset:\s*calc\([^}]*--agent-gui-workbench-header-traffic-light-size[^}]*content:\s*"";[^}]*transition:\s*background-color 160ms ease;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-light-icon\s*{[^}]*inset:\s*5px;[^}]*width:\s*10px;[^}]*height:\s*10px;[^}]*opacity:\s*0;[^}]*transition:\s*opacity 120ms ease;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-lights:hover\s+\.agent-gui-workbench-header__traffic-light-icon,\s*\.agent-gui-workbench-header__traffic-lights:focus-within\s+\.agent-gui-workbench-header__traffic-light-icon\s*{[^}]*opacity:\s*1;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__traffic-lights:hover\s+\.agent-gui-workbench-header__traffic-light\[data-agent-gui-workbench-traffic-light="close"\]::before,\s*\.agent-gui-workbench-header__traffic-lights:focus-within\s+\.agent-gui-workbench-header__traffic-light\[data-agent-gui-workbench-traffic-light="close"\]::before\s*{[^}]*background-color:\s*#ff5f57;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__agent-brand\s*{[^}]*gap:\s*8px;/s
    );
    expect(css).toMatch(
      /\.agent-gui-workbench-header__agent-brand\s*{[^}]*flex:\s*0\s+0\s+auto;/s
    );
    const agentNameCss = css.match(
      /\.agent-gui-workbench-header__agent-name\s*{(?<body>[^}]*)}/s
    )?.groups?.body;
    expect(agentNameCss).toBeDefined();
    expect(agentNameCss).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(agentNameCss).not.toMatch(/overflow:\s*hidden/);
    expect(css).toMatch(
      /\.agent-gui-workbench-header__rail-toggle\s*{[^}]*margin-left:\s*auto;/s
    );
  });
});
