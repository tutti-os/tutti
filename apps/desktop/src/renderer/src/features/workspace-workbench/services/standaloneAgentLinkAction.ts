import type { DesktopRuntimeApi } from "@preload/types";
import type { WorkspaceLinkAction } from "@contexts/workspace/presentation/renderer/actions/workspaceLinkActions";
import {
  runDesktopAgentGUILinkAction,
  type DesktopAgentGUILinkActionDependencies
} from "../../workspace-agent/services/desktopAgentGUILinkActions.ts";

export interface StandaloneAgentLinkActionDependencies extends Omit<
  DesktopAgentGUILinkActionDependencies,
  "openBrowserUrl"
> {
  openExternalUrl(url: string): Promise<void>;
  runtimeApi: Pick<DesktopRuntimeApi, "logRendererDiagnostic">;
}

export async function runStandaloneAgentLinkAction(
  action: WorkspaceLinkAction,
  dependencies: StandaloneAgentLinkActionDependencies
): Promise<boolean> {
  await logStandaloneAgentLinkDiagnostic(dependencies, {
    details: {
      actionSource: action.source,
      actionType: action.type
    },
    event: "agent.gui.standalone_link_action.received"
  });

  try {
    const handled = await runDesktopAgentGUILinkAction(action, {
      ...dependencies,
      openBrowserUrl: async ({ url }) => {
        const urlDetails = describeExternalUrl(url);
        await logStandaloneAgentLinkDiagnostic(dependencies, {
          details: urlDetails,
          event: "agent.gui.standalone_external_link.open_requested"
        });
        try {
          await dependencies.openExternalUrl(url);
          await logStandaloneAgentLinkDiagnostic(dependencies, {
            details: urlDetails,
            event: "agent.gui.standalone_external_link.open_succeeded"
          });
          return true;
        } catch (error) {
          await logStandaloneAgentLinkDiagnostic(dependencies, {
            details: {
              ...urlDetails,
              error: stringifyDiagnosticError(error)
            },
            event: "agent.gui.standalone_external_link.open_failed",
            level: "warn"
          });
          return false;
        }
      }
    });
    await logStandaloneAgentLinkDiagnostic(dependencies, {
      details: {
        actionType: action.type,
        handled
      },
      event: "agent.gui.standalone_link_action.settled",
      level: handled ? "info" : "warn"
    });
    return handled;
  } catch (error) {
    await logStandaloneAgentLinkDiagnostic(dependencies, {
      details: {
        actionType: action.type,
        error: stringifyDiagnosticError(error)
      },
      event: "agent.gui.standalone_link_action.failed",
      level: "warn"
    });
    return false;
  }
}

async function logStandaloneAgentLinkDiagnostic(
  dependencies: Pick<
    StandaloneAgentLinkActionDependencies,
    "runtimeApi" | "workspaceId"
  >,
  input: {
    details: Record<string, unknown>;
    event: string;
    level?: "info" | "warn";
  }
): Promise<void> {
  try {
    await dependencies.runtimeApi.logRendererDiagnostic({
      details: input.details,
      event: input.event,
      level: input.level ?? "info",
      source: "standalone-agent-link",
      workspaceId: dependencies.workspaceId
    });
  } catch {
    // Diagnostic transport must never block the user action it observes.
  }
}

function describeExternalUrl(url: string): Record<string, unknown> {
  try {
    const parsed = new URL(url);
    return {
      urlHost: parsed.host,
      urlLength: url.length,
      urlProtocol: parsed.protocol
    };
  } catch {
    return {
      urlHost: null,
      urlLength: url.length,
      urlProtocol: null
    };
  }
}

function stringifyDiagnosticError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
