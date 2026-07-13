import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { TerminalNodeI18nKey } from "@tutti-os/workspace-terminal/i18n";
import type {
  WorkbenchContribution,
  WorkbenchHostHandle
} from "@tutti-os/workbench-surface";
import { Button, CloseIcon, cn } from "@tutti-os/ui-system";
import { getWorkspaceTerminalSurfaceRuntime } from "../services/workspaceTerminalSurfaceRuntime.ts";
import type { StandaloneAgentSharedToolPanelId } from "./standaloneAgentToolSidebarModel.ts";
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
  closeLabel,
  contributions,
  loadingLabel,
  onClose,
  open,
  setToolHost,
  unavailableLabel
}: {
  closeLabel: string;
  contributions: readonly WorkbenchContribution[] | undefined;
  loadingLabel: string;
  onClose: () => void;
  open: boolean;
  setToolHost: (
    panel: StandaloneAgentSharedToolPanelId,
    host: WorkbenchHostHandle | null
  ) => void;
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
  const [nodeId] = useState(createStandaloneAgentTerminalNodeId);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [launchError, setLaunchError] = useState(false);
  const launchPromiseRef = useRef<Promise<void> | null>(null);
  const directHost = useMemo(createStandaloneAgentDirectToolHost, []);
  const externalState = useExternalStoreValue(
    runtime?.subscribe ?? emptySubscribe,
    () => runtime?.getExternalState(sessionId) ?? null,
    () => null
  );

  useEffect(() => {
    setToolHost("terminal", directHost.host);
    return () => setToolHost("terminal", null);
  }, [directHost, setToolHost]);

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
        "relative shrink-0 overflow-hidden border-t border-[var(--border-1)] bg-[var(--background-fronted)] transition-[height] duration-200 ease-out",
        !open && "pointer-events-none border-t-0"
      )}
      data-standalone-agent-terminal-panel="true"
      style={{ height: open ? "clamp(220px, 42vh, 440px)" : "0px" }}
    >
      {open ? (
        <Button
          aria-label={closeLabel}
          className="absolute top-2 right-2 z-20 bg-[var(--background-panel)] shadow-sm"
          data-standalone-agent-terminal-close="true"
          size="icon-sm"
          title={closeLabel}
          type="button"
          variant="chrome"
          onClick={onClose}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <CloseIcon aria-hidden className="size-3.5" />
        </Button>
      ) : null}
      <div
        className="h-full min-h-0 overflow-hidden"
        data-standalone-agent-terminal-surface="true"
      >
        {runtime && sessionId ? (
          <Suspense
            fallback={<StandaloneAgentToolLoadingState label={loadingLabel} />}
          >
            <LazyTerminalNode
              externalState={externalState}
              feature={runtime.feature}
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

function emptySubscribe(): () => void {
  return () => undefined;
}
