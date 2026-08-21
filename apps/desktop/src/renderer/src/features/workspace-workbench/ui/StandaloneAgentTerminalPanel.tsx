import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { TerminalTheme } from "@tutti-os/workspace-terminal/contracts";
import type { TerminalNodeI18nKey } from "@tutti-os/workspace-terminal/i18n";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { cn } from "@tutti-os/ui-system";
import { getWorkspaceTerminalSurfaceRuntime } from "../services/workspaceTerminalSurfaceRuntime.ts";
import { createStandaloneAgentDirectToolHost } from "./standaloneAgentToolWorkbench.ts";
import { useExternalStoreValue } from "./useExternalStoreValue.ts";
import { StandaloneAgentToolLoadingState } from "./StandaloneAgentToolLoadingState.tsx";

const LazyTerminalNode = lazy(() =>
  import("@tutti-os/workspace-terminal/react").then(({ TerminalNode }) => ({
    default: TerminalNode
  }))
);

const terminalCloseGuardDescriptionI18nKey: TerminalNodeI18nKey =
  "closeGuard.description";

export function StandaloneAgentTerminalPanel({
  contributions,
  instanceId,
  initialSessionId,
  loadingLabel,
  open,
  setToolHost,
  unavailableLabel
}: {
  contributions: readonly WorkbenchContribution[] | undefined;
  instanceId: string;
  initialSessionId?: string | null;
  loadingLabel: string;
  open: boolean;
  setToolHost: (instanceId: string, host: WorkbenchHostHandle | null) => void;
  unavailableLabel: string;
}): ReactNode {
  const runtime = useMemo(() => {
    const contribution = contributions?.find(
      (candidate) => candidate.id === "workspace-terminal"
    );
    return contribution
      ? getWorkspaceTerminalSurfaceRuntime(contribution)
      : null;
  }, [contributions]);
  const terminalFeature = useMemo(() => {
    if (!runtime) {
      return null;
    }
    return {
      ...runtime.feature,
      resolveTheme(input: Parameters<typeof runtime.feature.resolveTheme>[0]) {
        const panelTheme = resolveStandaloneAgentTerminalTheme();
        const terminalTheme = runtime.feature.resolveTheme(input);
        return {
          ...panelTheme,
          ...terminalTheme,
          background: panelTheme.background ?? terminalTheme.background
        };
      }
    };
  }, [runtime]);
  const [nodeId] = useState(createStandaloneAgentTerminalNodeId);
  const [sessionId, setSessionId] = useState<string | null>(
    initialSessionId?.trim() || null
  );
  const [launchError, setLaunchError] = useState(false);
  const launchPromiseRef = useRef<Promise<void> | null>(null);
  const directHost = useMemo(createStandaloneAgentDirectToolHost, []);
  const externalState = useExternalStoreValue(
    runtime?.subscribe ?? emptySubscribe,
    () => runtime?.getExternalState(sessionId) ?? null,
    () => null
  );

  useEffect(() => {
    setToolHost(instanceId, directHost.host);
    return () => setToolHost(instanceId, null);
  }, [directHost, instanceId, setToolHost]);

  useEffect(() => {
    directHost.setNode(
      sessionId
        ? {
            instanceId: sessionId,
            nodeId,
            resolveCloseEffect: async () => {
              const latestState = runtime?.getExternalState(sessionId) ?? null;
              if (
                !runtime ||
                !latestState ||
                latestState.status === "created" ||
                latestState.status === "exited" ||
                latestState.status === "failed"
              ) {
                return null;
              }
              try {
                const guard = await runtime.feature.closeGuard.check({
                  sessionId
                });
                if (
                  !guard.requiresConfirmation ||
                  guard.reason === "not-running" ||
                  guard.status === "exited" ||
                  guard.status === "failed"
                ) {
                  return null;
                }
              } catch {
                // Preserve the OS terminal's conservative close behavior when
                // the daemon cannot resolve the guard state.
              }
              return {
                description: runtime.feature.i18n.t(
                  terminalCloseGuardDescriptionI18nKey
                ),
                nodeId,
                title: latestState.title,
                typeId: "workspace-terminal"
              };
            },
            title: externalState?.title ?? "",
            typeId: "workspace-terminal"
          }
        : null
    );
  }, [directHost, externalState?.title, nodeId, runtime, sessionId]);

  useEffect(() => {
    if (!open || !runtime || sessionId || launchPromiseRef.current) {
      return;
    }
    setLaunchError(false);
    const launchPromise = runtime
      .createSession()
      .then((session) => setSessionId(session.sessionId))
      .catch(() => setLaunchError(true))
      .finally(() => {
        if (launchPromiseRef.current === launchPromise) {
          launchPromiseRef.current = null;
        }
      });
    launchPromiseRef.current = launchPromise;
  }, [open, runtime, sessionId]);

  return (
    <section
      aria-hidden={!open}
      className={cn(
        "relative h-full min-h-0 overflow-hidden bg-[var(--background-session-sidepanel)]",
        !open && "pointer-events-none"
      )}
      data-standalone-agent-terminal-panel="true"
      style={
        {
          "--tutti-surface": "var(--background-session-sidepanel)"
        } as CSSProperties
      }
    >
      <div
        className="h-full min-h-0 overflow-hidden"
        data-standalone-agent-terminal-surface="true"
      >
        {terminalFeature && sessionId ? (
          <Suspense
            fallback={<StandaloneAgentToolLoadingState label={loadingLabel} />}
          >
            <LazyTerminalNode
              externalState={externalState}
              feature={terminalFeature}
              nodeId={nodeId}
              sessionId={sessionId}
              showHeader={false}
            />
          </Suspense>
        ) : launchError || !runtime ? (
          <div
            className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]"
            role="status"
          >
            {unavailableLabel}
          </div>
        ) : (
          <StandaloneAgentToolLoadingState label={loadingLabel} />
        )}
      </div>
    </section>
  );
}

function createStandaloneAgentTerminalNodeId(): string {
  const instanceId =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `workspace-terminal:standalone-agent-tool:${instanceId}`;
}

function resolveStandaloneAgentTerminalTheme(): TerminalTheme {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return {};
  }
  const styles = window.getComputedStyle(document.documentElement);
  const background = styles
    .getPropertyValue("--background-session-sidepanel")
    .trim();
  const foreground = styles.getPropertyValue("--text-primary").trim();
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { cursor: foreground, foreground } : {})
  };
}

function emptySubscribe(): () => void {
  return () => undefined;
}
